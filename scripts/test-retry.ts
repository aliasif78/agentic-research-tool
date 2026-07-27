// scripts/test-retry.ts
// Unit-tests withRetry() directly against synthetic functions — not through
// Tavily. Forcing a real API to return 503s/429s on demand isn't reliable;
// this isolates the actual unit under test: the retry/backoff/classification
// logic itself.
import assert from "node:assert/strict";
import { withRetry, type RetryClassification } from "@/lib/retry";

class FakeTransientError extends Error {}
class FakePermanentError extends Error {}

function classify(err: unknown): RetryClassification {
  if (err instanceof FakeTransientError) return "retryable";
  return "not-retryable";
}

async function testRetriesThenSucceeds() {
  console.log("\n=== Test 1: fails twice (retryable), succeeds on 3rd attempt ===");
  let callCount = 0;

  const { result, attempts, attemptLog } = await withRetry(
    async () => {
      callCount++;
      if (callCount < 3) throw new FakeTransientError(`synthetic failure #${callCount}`);
      return "success-payload";
    },
    { maxAttempts: 3, baseDelayMs: 300, maxDelayMs: 4000, classify },
  );

  console.log(JSON.stringify({ result, attempts, attemptLog }, null, 2));

  assert.equal(result, "success-payload", "should return the eventual success value");
  assert.equal(attempts, 3, "should have taken exactly 3 attempts");
  assert.equal(callCount, 3, "underlying fn should have been called exactly 3 times");
  assert.equal(attemptLog.length, 3, "should log all 3 attempts, including the final success");

  assert.equal(attemptLog[2].classification, "success", "3rd entry should log the success, not just be absent");
  assert.equal(attemptLog[2].errorMessage, null, "success entry should have no error message");

  // First two entries are the failures with backoff delay; classification must be retryable.
  assert.equal(attemptLog[0].classification, "retryable");
  assert.equal(attemptLog[1].classification, "retryable");

  // Delay bounds: full jitter means delay is Math.random() * exp, so 0 <= delay <= exp.
  // attempt 1 exp = baseDelayMs * 2^0 = 300; attempt 2 exp = baseDelayMs * 2^1 = 600.
  assert.ok(attemptLog[0].delayMs >= 0 && attemptLog[0].delayMs <= 300, `attempt 1 delay out of bounds: ${attemptLog[0].delayMs}`);
  assert.ok(attemptLog[1].delayMs >= 0 && attemptLog[1].delayMs <= 600, `attempt 2 delay out of bounds: ${attemptLog[1].delayMs}`);

  console.log("PASS: retries on transient error, backoff delays within expected bounds, succeeds on 3rd attempt.");
}

async function testExhaustsRetriesAndThrows() {
  console.log("\n=== Test 2: persistent retryable error exhausts maxAttempts, throws ===");
  let callCount = 0;

  await assert.rejects(
    () =>
      withRetry(
        async () => {
          callCount++;
          throw new FakeTransientError(`persistent failure #${callCount}`);
        },
        { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, classify },
      ),
    (err: unknown) => {
      console.log("Thrown error message:", err instanceof Error ? err.message : String(err));
      const attemptLog = (err as { attemptLog?: unknown[] }).attemptLog;
      console.log("Attached attemptLog:", JSON.stringify(attemptLog, null, 2));

      assert.ok(Array.isArray(attemptLog), "thrown error should carry attemptLog");
      assert.equal(attemptLog!.length, 3, "should have attempted exactly 3 times before giving up");
      assert.equal(callCount, 3, "underlying fn should have been called exactly 3 times, not more");
      // Final attempt gives up immediately — no point delaying before throwing.
      assert.equal((attemptLog![2] as { delayMs: number }).delayMs, 0, "final failed attempt should log delayMs: 0");
      return true;
    },
  );

  console.log("PASS: exhausts maxAttempts on persistent transient error, throws with attemptLog attached.");
}

async function testNonRetryableFailsImmediately() {
  console.log("\n=== Test 3: non-retryable error fails on first attempt, no retry ===");
  let callCount = 0;

  await assert.rejects(
    () =>
      withRetry(
        async () => {
          callCount++;
          throw new FakePermanentError("synthetic auth failure");
        },
        { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, classify },
      ),
    (err: unknown) => {
      const attemptLog = (err as { attemptLog?: unknown[] }).attemptLog;
      console.log("Attached attemptLog:", JSON.stringify(attemptLog, null, 2));

      assert.equal(callCount, 1, "underlying fn should be called exactly once — no retries on non-retryable error");
      assert.equal(attemptLog!.length, 1, "should log exactly one attempt");
      assert.equal((attemptLog![0] as { classification: string }).classification, "not-retryable");
      assert.equal((attemptLog![0] as { delayMs: number }).delayMs, 0, "non-retryable failure should not incur a delay");
      return true;
    },
  );

  console.log("PASS: non-retryable error fails immediately on attempt 1, no wasted retries.");
}

async function main() {
  await testRetriesThenSucceeds();
  await testExhaustsRetriesAndThrows();
  await testNonRetryableFailsImmediately();
  console.log("\n=== All withRetry unit tests passed. ===");
}

main().catch((err) => {
  console.error("\n=== TEST SUITE FAILED ===");
  console.error(err);
  process.exit(1);
});
