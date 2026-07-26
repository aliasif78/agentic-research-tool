// lib/tools/web-search.ts
import { tool } from "ai";
import { z } from "zod";

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
}

interface TavilySearchResponse {
  results: TavilySearchResult[];
}

export const webSearchTool = tool({
  description: "Search the web for current information on a topic. Returns a list of results with title, url, and snippet.",
  inputSchema: z.object({
    query: z.string().min(1).describe("The search query"),
  }),
  execute: async ({ query }) => {
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query,
          max_results: 5,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        return {
          success: false as const,
          error: `Tavily returned ${res.status}: ${body.slice(0, 200)}`,
        };
      }

      const data: TavilySearchResponse = await res.json();
      const results = (data.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
      }));

      if (results.length === 0) {
        return {
          success: false as const,
          error: "No search results found for this query.",
        };
      }

      return { success: true as const, results };
    } catch (err) {
      return {
        success: false as const,
        error: `Search request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
