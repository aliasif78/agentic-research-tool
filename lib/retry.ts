// lib/retry.ts

export type RetryClassification = "retryable" | "not-retryable";
export type AttemptOutcome = "success" | RetryClassification;

export interface RetryAttemptLog {
  attempt: number;
  delayMs: number;
  classification: AttemptOutcome;
  errorMessage: string | null;
}

export interface RetryResult<T> {
  result: T;
  attempts: number;
  attemptLog: RetryAttemptLog[];
}

interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  classify: (err: unknown) => RetryClassification;
}

function delayWithJitter(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  // Full jitter: prevents thundering-herd retries if you ever run this concurrently.
  return Math.random() * exp;
}

/**
 * Wraps an async operation with exponential backoff + jitter, retrying only
 * errors classified as "retryable". Non-retryable errors throw immediately
 * on first occurrence — no wasted attempts, no wasted latency.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<RetryResult<T>> {
  const attemptLog: RetryAttemptLog[] = [];

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      const result = await fn();
      // Log the success too — omitting it left the attempt log incomplete,
      // which would show up as a missing span once this feeds Langfuse.
      attemptLog.push({ attempt, delayMs: 0, classification: "success", errorMessage: null });
      return { result, attempts: attempt, attemptLog };
    } catch (err) {
      const classification = options.classify(err);
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (classification === "not-retryable" || attempt === options.maxAttempts) {
        attemptLog.push({ attempt, delayMs: 0, classification, errorMessage });
        throw Object.assign(err instanceof Error ? err : new Error(errorMessage), { attemptLog });
      }

      const delayMs = delayWithJitter(attempt, options.baseDelayMs, options.maxDelayMs);
      attemptLog.push({ attempt, delayMs, classification, errorMessage });
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  throw new Error("unreachable: loop should always return or throw");
}
