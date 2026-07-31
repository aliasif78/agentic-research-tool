// lib/tools/summarize-notes.ts
import { z } from "zod";
import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { createSupabaseAdminClient } from "../supabase/admin-client";
import { generateWithFallback } from "@/lib/models/generate-with-fallback";

export const summarizeNotesInputSchema = z.object({});

export interface SummarizeNotesSuccess {
  summary: string;
  modelUsed: string;
  fallbackTriggered: boolean;
}

/**
 * Pure function, extracted from the deleted AI-SDK tool() wrapper — same
 * pattern already applied to insertNote() in save-note.ts. NOT yet called
 * from research-agent.ts; Phase 3 left summarizeNotes as a stub there.
 * Wiring this in (DB read and the nested generateText call each as their
 * own Inngest step.run()) is a separate, not-yet-scoped increment. This is
 * real, working logic carried over intact — not new work invented during
 * this cleanup pass.
 *
 * Returns a discriminated result for the "no notes / no data" business
 * case (not an exception — same convention as callTavily's "no results"
 * case). A genuine system failure (both models down in generateWithFallback,
 * or a Supabase read error) throws, for the caller to classify the same
 * way webSearch/saveNote's step bodies already do.
 */
export async function summarizeAllNotes({ runId, abortSignal }: { runId: string; abortSignal?: AbortSignal }): Promise<{ success: true; result: SummarizeNotesSuccess } | { success: false; error: string }> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from("research_notes").select("content").eq("run_id", runId).order("created_at", { ascending: true });

  if (error) return { success: false, error: `Failed to retrieve notes: ${error.message}` };
  if (!data || data.length === 0) return { success: false, error: "No notes have been saved yet for this session." };

  const notesText = data.map((n, i) => `${i + 1}. ${n.content}`).join("\n");
  const timeoutSignal = AbortSignal.timeout(15_000);
  const combinedSignal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;

  const {
    result: genResult,
    modelUsed,
    fallbackTriggered,
  } = await generateWithFallback((modelId) =>
    generateText({
      model: google(modelId),
      abortSignal: combinedSignal,
      maxRetries: 3,
      prompt: `Condense the following research notes into a concise summary, preserving all key facts:\n\n${notesText}`,
    }),
  );

  return { success: true, result: { summary: genResult.text, modelUsed, fallbackTriggered } };
}
