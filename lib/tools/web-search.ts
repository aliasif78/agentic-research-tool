// lib/tools/web-search.ts
import { tool } from "ai";
import { z } from "zod";
import { startActiveObservation } from "@langfuse/tracing";
import { withRetry, type RetryClassification } from "@/lib/retry";

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
}

interface TavilySearchResponse {
  results: TavilySearchResult[];
}

class TavilyHttpError extends Error {
  constructor(
    public status: number,
    body: string,
  ) {
    super(`Tavily returned ${status}: ${body.slice(0, 200)}`);
  }
}

function classifyTavilyError(err: unknown): RetryClassification {
  if (err instanceof TavilyHttpError) {
    // 401/403 = bad key, 400 = malformed request — retrying won't fix either.
    // 429/500/502/503/504 = transient, worth another attempt.
    if ([401, 403, 400].includes(err.status)) return "not-retryable";
    if ([429, 500, 502, 503, 504].includes(err.status)) return "retryable";
    return "not-retryable"; // unknown status: fail closed, don't assume retryable
  }
  if (err instanceof DOMException && err.name === "TimeoutError") return "retryable";
  if (err instanceof TypeError) return "retryable"; // fetch network failure
  return "not-retryable";
}

async function callTavily(query: string): Promise<TavilySearchResponse> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: 5 }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new TavilyHttpError(res.status, body);
  }

  return res.json();
}

export const webSearchTool = tool({
  description: "Search the web for current information on a topic. Returns a list of results with title, url, and snippet.",
  inputSchema: z.object({ query: z.string().min(1).describe("The search query") }),
  execute: async ({ query }) => {
    console.log(`[webSearch] tool call started for "${query}" at ${new Date().toISOString()}`);

    return startActiveObservation("webSearch-tool-call", async (toolSpan) => {
      toolSpan.update({ input: { query }, metadata: { toolName: "webSearch" } });

      try {
        const {
          result: data,
          attempts,
          attemptLog,
        } = await withRetry(() => callTavily(query), {
          maxAttempts: 3,
          baseDelayMs: 500,
          maxDelayMs: 4000,
          classify: classifyTavilyError,
          onAttempt: (log) => {
            const attemptSpan = toolSpan.startObservation(`webSearch-attempt-${log.attempt}`, {
              input: { query, attemptNumber: log.attempt },
              metadata: { classification: log.classification },
            });
            attemptSpan.update({ output: { errorMessage: log.errorMessage, delayMs: log.delayMs } });
            attemptSpan.end();
          },
        });

        const results = (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));

        if (results.length === 0) {
          toolSpan.update({ output: { success: false, error: "No results" }, level: "WARNING" });
          return { success: false as const, error: "No search results found for this query.", attempts, attemptLog };
        }

        toolSpan.update({ output: { success: true, resultCount: results.length, attempts } });
        return { success: true as const, results, attempts, attemptLog };
      } catch (err) {
        const attemptLog = (err as { attemptLog?: unknown }).attemptLog;
        const errorMessage = err instanceof Error ? err.message : String(err);
        toolSpan.update({ output: { success: false, error: errorMessage }, level: "ERROR" });
        return { success: false as const, error: errorMessage, attemptLog };
      }
    });
  },
});
