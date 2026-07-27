// lib/models/generate-with-fallback.ts
import { APICallError } from "ai";

export const PRIMARY_MODEL = "gemini-3.1-flash-lite";
export const FALLBACK_MODEL = "gemini-2.5-flash";

type ModelId = typeof PRIMARY_MODEL | typeof FALLBACK_MODEL;
type ErrorClassification = "retryable" | "not-retryable";

// Classifies the error AI SDK throws *after* the primary model's own
// maxRetries is already exhausted. Only 429/5xx/network/timeout are worth
// trying the fallback model for — both models share the same API key, so a
// 401/403/400 on the primary will fail identically on the fallback. Gemini
// rate limits and capacity are typically per-model, not per-account, which
// is why 429/5xx specifically are worth a different model.
function classifyModelError(err: unknown): ErrorClassification {
  if (APICallError.isInstance(err)) {
    const status = err.statusCode;
    if (status === 429 || (status !== undefined && status >= 500)) return "retryable";
    return "not-retryable";
  }
  if (err instanceof TypeError) return "retryable"; // raw fetch-level network failure
  if (err instanceof DOMException && err.name === "TimeoutError") return "retryable";
  return "not-retryable"; // unrecognized error shape — fail closed, don't burn a fallback call on a guess
}

export interface GenerateWithFallbackResult<T> {
  result: T;
  modelUsed: ModelId;
  fallbackTriggered: boolean;
  primaryError: string | null;
}

/**
 * Runs `callModel(PRIMARY_MODEL)` first. If that call throws after
 * exhausting its own internal maxRetries, and the error is classified as
 * retryable (429/5xx/network/timeout), retries once against FALLBACK_MODEL.
 * Non-retryable errors (401/403/400) surface immediately — trying the
 * fallback would fail identically since both models share one API key.
 */
export async function generateWithFallback<T>(callModel: (modelId: ModelId) => Promise<T>): Promise<GenerateWithFallbackResult<T>> {
  try {
    const result = await callModel(PRIMARY_MODEL);
    return { result, modelUsed: PRIMARY_MODEL, fallbackTriggered: false, primaryError: null };
  } catch (err) {
    const classification = classifyModelError(err);
    const primaryError = err instanceof Error ? err.message : String(err);

    if (classification === "not-retryable") {
      throw Object.assign(err instanceof Error ? err : new Error(primaryError), {
        modelUsed: PRIMARY_MODEL,
        fallbackTriggered: false,
      });
    }

    try {
      const result = await callModel(FALLBACK_MODEL);
      return { result, modelUsed: FALLBACK_MODEL, fallbackTriggered: true, primaryError };
    } catch (fallbackErr) {
      const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw Object.assign(new Error(`Both models failed. Primary (${PRIMARY_MODEL}): ${primaryError}. Fallback (${FALLBACK_MODEL}): ${fallbackMessage}`), {
        modelUsed: null,
        fallbackTriggered: true,
      });
    }
  }
}
