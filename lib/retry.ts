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
  onAttempt?: (log: RetryAttemptLog) => void; // caller-supplied tracing hook — retry.ts stays agnostic to whatever observability tool is wired in
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
      const log: RetryAttemptLog = { attempt, delayMs: 0, classification: "success", errorMessage: null };
      attemptLog.push(log);
      options.onAttempt?.(log);
      return { result, attempts: attempt, attemptLog };
    } catch (err) {
      const classification = options.classify(err);
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (classification === "not-retryable" || attempt === options.maxAttempts) {
        const log: RetryAttemptLog = { attempt, delayMs: 0, classification, errorMessage };
        attemptLog.push(log);
        options.onAttempt?.(log);
        throw Object.assign(err instanceof Error ? err : new Error(errorMessage), { attemptLog });
      }

      const delayMs = delayWithJitter(attempt, options.baseDelayMs, options.maxDelayMs);
      const log: RetryAttemptLog = { attempt, delayMs, classification, errorMessage };
      attemptLog.push(log);
      options.onAttempt?.(log);
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  throw new Error("unreachable: loop should always return or throw");
}
