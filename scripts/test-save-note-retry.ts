// scripts/test-save-note-retry.ts
// Tests classifySupabaseError + withRetry integration against synthetic
// errors only. No real Supabase connection is touched — forcing a real
// connection-class Postgres error on demand isn't reliable, same reasoning
// as test-retry.ts's approach to Tavily.
import assert from "node:assert/strict";
import { withRetry } from "@/lib/retry";
import { classifySupabaseError, SupabaseInsertError } from "@/lib/tools/save-note";

async function testConnectionErrorRetriesThenSucceeds() {
  console.log("\n=== Test 1: synthetic connection-class error (SQLSTATE 08xxx) retries, then succeeds ===");
  let callCount = 0;

  const { result, attempts, attemptLog } = await withRetry(
    async () => {
      callCount++;
      if (callCount < 2) {
        throw new SupabaseInsertError("Supabase insert failed: fetch failed (code: 08006)");
      }
      return { id: "fake-note-id" };
    },
    { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000, classify: classifySupabaseError },
  );

  console.log(JSON.stringify({ result, attempts, attemptLog }, null, 2));

  assert.equal(attempts, 2, "should succeed on 2nd attempt");
  assert.equal(callCount, 2, "underlying insert should be called exactly twice");
  assert.equal(result.id, "fake-note-id");
  assert.equal(attemptLog[0].classification, "retryable");
  assert.equal(attemptLog[1].classification, "success");
  console.log("PASS: connection-class error retried, succeeded on 2nd attempt.");
}

async function testConstraintViolationFailsImmediately() {
  console.log("\n=== Test 2: synthetic unique-constraint violation (23505) is NOT retried ===");
  let callCount = 0;

  await assert.rejects(
    () =>
      withRetry(
        async () => {
          callCount++;
          throw new SupabaseInsertError("Supabase insert failed: duplicate key value violates unique constraint (code: 23505)");
        },
        { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000, classify: classifySupabaseError },
      ),
    (err: unknown) => {
      const attemptLog = (err as { attemptLog?: unknown[] }).attemptLog;
      console.log("Attached attemptLog:", JSON.stringify(attemptLog, null, 2));
      assert.equal(callCount, 1, "a constraint violation must not be retried — retrying can't fix bad data");
      assert.equal(attemptLog!.length, 1);
      assert.equal((attemptLog![0] as { classification: string }).classification, "not-retryable");
      return true;
    },
  );

  console.log("PASS: constraint violation fails on attempt 1, no wasted retries.");
}

async function testRawNetworkTypeErrorIsRetryable() {
  console.log("\n=== Test 3: raw TypeError (fetch-level network failure, before Supabase returns a response) is retryable ===");
  let callCount = 0;

  const { result, attempts } = await withRetry(
    async () => {
      callCount++;
      if (callCount < 2) throw new TypeError("fetch failed");
      return { id: "recovered-after-network-blip" };
    },
    { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000, classify: classifySupabaseError },
  );

  assert.equal(attempts, 2);
  assert.equal(callCount, 2);
  assert.equal(result.id, "recovered-after-network-blip");
  console.log("PASS: raw network TypeError classified as retryable, recovered on 2nd attempt.");
}

async function main() {
  await testConnectionErrorRetriesThenSucceeds();
  await testConstraintViolationFailsImmediately();
  await testRawNetworkTypeErrorIsRetryable();
  console.log("\n=== All save-note retry classification tests passed. ===");
}

main().catch((err) => {
  console.error("\n=== TEST SUITE FAILED ===");
  console.error(err);
  process.exit(1);
});
