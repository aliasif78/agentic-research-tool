// lib/tools/web-search.ts
import { tool } from "ai";
import { z } from "zod";
import { startActiveObservation } from "@langfuse/tracing";

export const webSearchInputSchema = z.object({ query: z.string().min(1).describe("The search query") });

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
}

interface TavilySearchResponse {
  results: TavilySearchResult[];
}

export class TavilyHttpError extends Error {
  constructor(
    public status: number,
    body: string,
  ) {
    super(`Tavily returned ${status}: ${body.slice(0, 200)}`);
  }
}

// Retained for Phase 3: Inngest's step retry needs this classification to
// decide whether to throw NonRetriableError (401/403/400 — retrying won't
// fix a bad key or malformed request) or let a plain throw happen so
// Inngest's own backoff retries the step (429/5xx/timeout/network).
export function classifyTavilyError(err: unknown): "retryable" | "not-retryable" {
  if (err instanceof TavilyHttpError) {
    // 401/403 = bad key, 400 = malformed request — retrying won't fix either.
    // 429/500/502/503/504 = transient, worth another attempt.
    if ([401, 403, 400].includes(err.status)) return "not-retryable";
    if ([429, 500, 502, 503, 504].includes(err.status)) return "retryable";
    return "not-retryable";
  }
  if (err instanceof DOMException && err.name === "TimeoutError") return "retryable";
  if (err instanceof TypeError) return "retryable";
  return "not-retryable";
}

export async function callTavily(query: string): Promise<TavilySearchResponse> {
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

/**
 * LEGACY AI-SDK tool wrapper — single attempt, no retry. withRetry was
 * removed in Phase 2: Inngest now owns all retry/backoff for tool-level
 * side effects (Phase 3). This wrapper exists only for the old
 * synchronous route and ad-hoc scripts, which have no step-based retry —
 * a transient failure here fails the tool call once. Slated for deletion
 * once Phase 5 replaces route.ts.
 */
export const webSearchTool = tool({
  description: "Search the web for current information on a topic. Returns a list of results with title, url, and snippet.",
  inputSchema: webSearchInputSchema,
  execute: async ({ query }) => {
    console.log(`[webSearch] tool call started for "${query}" at ${new Date().toISOString()}`);

    return startActiveObservation("webSearch-tool-call", async (toolSpan) => {
      toolSpan.update({ input: { query }, metadata: { toolName: "webSearch" } });

      try {
        const data = await callTavily(query);
        const results = (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));

        if (results.length === 0) {
          toolSpan.update({ output: { success: false, error: "No results" }, level: "WARNING" });
          return { success: false as const, error: "No search results found for this query." };
        }

        toolSpan.update({ output: { success: true, resultCount: results.length } });
        return { success: true as const, results };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        toolSpan.update({ output: { success: false, error: errorMessage }, level: "ERROR" });
        return { success: false as const, error: errorMessage };
      }
    });
  },
});
