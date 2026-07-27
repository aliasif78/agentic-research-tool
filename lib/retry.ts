// lib/retry.ts

export type RetryClassification = "retryable" | "not-retryable";

export interface RetryAttemptLog {
  attempt: number;
  delayMs: number;
  classification: RetryClassification;
  errorMessage: string;
}

export interface RetryResult<T> {
  result: T;
  attempts: number;
  attemptLog: RetryAttemptLog[];
}

interface RetryOptions {
  maxAttempts: number; // total attempts, including the first — not "retries"
  baseDelayMs: number; // e.g. 500
  maxDelayMs: number; // cap on exponential growth, e.g. 8000
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
  let lastErr: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { result, attempts: attempt, attemptLog };
    } catch (err) {
      lastErr = err;
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

  // Unreachable given maxAttempts >= 1, but keeps TypeScript happy.
  throw lastErr;
}
