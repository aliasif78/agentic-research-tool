// lib/tools/web-search.ts
import { z } from "zod";

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
