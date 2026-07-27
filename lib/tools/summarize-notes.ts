// lib/tools/summarize-notes.ts
import { tool } from "ai";
import { z } from "zod";
import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { createSupabaseAdminClient } from "../supabase/admin-client";
import { generateWithFallback } from "@/lib/models/generate-with-fallback";

export const summarizeNotesTool = (sessionId: string) =>
  tool({
    description: "Retrieve all saved notes for this research session and condense them into a summary.",
    inputSchema: z.object({}),
    execute: async (_input, { abortSignal }) => {
      const supabase = createSupabaseAdminClient();
      const { data, error } = await supabase.from("research_notes").select("content").eq("session_id", sessionId).order("created_at", { ascending: true });

      if (error) {
        return { success: false as const, error: `Failed to retrieve notes: ${error.message}` };
      }

      if (!data || data.length === 0) {
        return { success: false as const, error: "No notes have been saved yet for this session." };
      }

      const notesText = data.map((n, i) => `${i + 1}. ${n.content}`).join("\n");

      // Combine the outer run's abort signal (if the caller forwarded one)
      // with a hard local ceiling, so this nested call can't hang even if
      // route.ts never wires up abortSignal on the outer generateText call.
      const timeoutSignal = AbortSignal.timeout(15_000);
      const combinedSignal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;

      try {
        const {
          result: genResult,
          modelUsed,
          fallbackTriggered,
          primaryError,
        } = await generateWithFallback((modelId) =>
          generateText({
            model: google(modelId),
            abortSignal: combinedSignal,
            maxRetries: 3, // AI SDK's own retryWithExponentialBackoff — exhausted
            // before generateWithFallback ever sees an error.
            prompt: `Condense the following research notes into a concise summary, preserving all key facts:\n\n${notesText}`,
          }),
        );

        const { text, usage } = genResult;

        // Deliberately NOT returned in the tool result — the return value
        // gets fed back to the model as tool output. Token counts there
        // are wasted context and mean nothing to the model. Log it as a
        // side channel instead; this is your Phase 3 cost-accounting hook.
        console.log("[summarizeNotesTool] nested LLM call:", { sessionId, modelUsed, fallbackTriggered, primaryError, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens });

        return { success: true as const, summary: text, modelUsed, fallbackTriggered };
      } catch (err) {
        const isTimeout = err instanceof Error && err.name === "TimeoutError";
        const modelUsed = (err as { modelUsed?: string | null }).modelUsed ?? null;
        const fallbackTriggered = (err as { fallbackTriggered?: boolean }).fallbackTriggered ?? false;

        console.error("[summarizeNotesTool] both models failed:", { sessionId, modelUsed, fallbackTriggered, error: err instanceof Error ? err.message : String(err) });

        return {
          success: false as const,
          error: isTimeout ? "Summarization call timed out after 15s." : `Summarization call failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });
