// scripts/test-fallback.ts
// Tests generateWithFallback's error classification and control flow against
// synthetic errors only — not through real Gemini calls. Forcing a real
// 429/503 from Google on demand isn't reliable, same reasoning as
// test-retry.ts and test-save-note-retry.ts.
import assert from "node:assert/strict";
import { APICallError } from "ai";
import { generateWithFallback, PRIMARY_MODEL, FALLBACK_MODEL } from "@/lib/models/generate-with-fallback";

function makeApiCallError(statusCode: number, message: string): APICallError {
  // VERIFY this constructor shape against node_modules/@ai-sdk/provider's
  // actual .d.ts before trusting this test — flagged in the chat, not
  // assumed correct from training data.
  return new APICallError({
    message,
    url: "https://example.invalid/synthetic",
    requestBodyValues: {},
    statusCode,
  });
}

async function testRetryableErrorFallsBackAndSucceeds() {
  console.log("\n=== Test 1: 429 on primary — falls back, fallback succeeds ===");

  const { result, modelUsed, fallbackTriggered, primaryError } = await generateWithFallback(async (modelId) => {
    if (modelId === PRIMARY_MODEL) {
      throw makeApiCallError(429, "Resource exhausted on primary");
    }
    return { text: "fallback succeeded", modelIdUsed: modelId };
  });

  console.log(JSON.stringify({ result, modelUsed, fallbackTriggered, primaryError }, null, 2));

  assert.equal(modelUsed, FALLBACK_MODEL, "should report the fallback model as the one that served the response");
  assert.equal(fallbackTriggered, true);
  assert.equal(primaryError, "Resource exhausted on primary");
  assert.equal(result.text, "fallback succeeded");
  console.log("PASS: 429 correctly triggers fallback, fallback model's result is returned.");
}

async function testServerErrorFallsBackAndSucceeds() {
  console.log("\n=== Test 2: 503 on primary — falls back, fallback succeeds ===");

  const { modelUsed, fallbackTriggered } = await generateWithFallback(async (modelId) => {
    if (modelId === PRIMARY_MODEL) {
      throw makeApiCallError(503, "Service unavailable");
    }
    return { text: "recovered" };
  });

  assert.equal(modelUsed, FALLBACK_MODEL);
  assert.equal(fallbackTriggered, true);
  console.log("PASS: 503 correctly triggers fallback.");
}

async function testAuthErrorSkipsFallbackEntirely() {
  console.log("\n=== Test 3: 401 on primary — does NOT try fallback, surfaces immediately ===");

  let fallbackWasCalled = false;

  await assert.rejects(
    () =>
      generateWithFallback(async (modelId) => {
        if (modelId === FALLBACK_MODEL) fallbackWasCalled = true;
        throw makeApiCallError(401, "Unauthorized: invalid API key");
      }),
    (err: unknown) => {
      const modelUsed = (err as { modelUsed?: string }).modelUsed;
      const fallbackTriggered = (err as { fallbackTriggered?: boolean }).fallbackTriggered;
      console.log("Thrown error:", err instanceof Error ? err.message : String(err));
      console.log("Attached fields:", { modelUsed, fallbackTriggered });

      assert.equal(fallbackWasCalled, false, "fallback model must never be called for a 401 — same API key means it would fail identically");
      assert.equal(modelUsed, PRIMARY_MODEL);
      assert.equal(fallbackTriggered, false);
      return true;
    },
  );

  console.log("PASS: 401 skips fallback entirely, no wasted call, correct error surfaced.");
}

async function testBothModelsFailThrowsCombinedError() {
  console.log("\n=== Test 4: primary gets 429, fallback ALSO fails — combined error thrown ===");

  await assert.rejects(
    () =>
      generateWithFallback(async (modelId) => {
        if (modelId === PRIMARY_MODEL) throw makeApiCallError(429, "Primary rate limited");
        throw makeApiCallError(503, "Fallback also down");
      }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.log("Combined error message:", message);
      const fallbackTriggered = (err as { fallbackTriggered?: boolean }).fallbackTriggered;
      const modelUsed = (err as { modelUsed?: string | null }).modelUsed;

      assert.match(message, /Primary rate limited/, "combined error should mention the primary's failure");
      assert.match(message, /Fallback also down/, "combined error should mention the fallback's failure");
      assert.equal(fallbackTriggered, true, "fallback was attempted even though it also failed");
      assert.equal(modelUsed, null, "no model succeeded, so modelUsed should be null");
      return true;
    },
  );

  console.log("PASS: both-models-fail case throws a combined error with both failure messages, correct metadata.");
}

async function testRawNetworkTypeErrorTriggersFallback() {
  console.log("\n=== Test 5: raw TypeError (fetch-level network failure) on primary triggers fallback ===");

  const { modelUsed, fallbackTriggered } = await generateWithFallback(async (modelId) => {
    if (modelId === PRIMARY_MODEL) throw new TypeError("fetch failed");
    return { text: "ok" };
  });

  assert.equal(modelUsed, FALLBACK_MODEL);
  assert.equal(fallbackTriggered, true);
  console.log("PASS: raw network TypeError classified as retryable, triggers fallback correctly.");
}

async function main() {
  await testRetryableErrorFallsBackAndSucceeds();
  await testServerErrorFallsBackAndSucceeds();
  await testAuthErrorSkipsFallbackEntirely();
  await testBothModelsFailThrowsCombinedError();
  await testRawNetworkTypeErrorTriggersFallback();
  console.log("\n=== All generateWithFallback tests passed. ===");
}

main().catch((err) => {
  console.error("\n=== TEST SUITE FAILED ===");
  console.error(err);
  process.exit(1);
});
