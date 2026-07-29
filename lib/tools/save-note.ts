// lib/tools/save-note.ts
import { tool } from "ai";
import { z } from "zod";
import { startActiveObservation } from "@langfuse/tracing";
import { createSupabaseAdminClient } from "../supabase/admin-client";

export class SupabaseInsertError extends Error {}

// Retained for Phase 3: Inngest's own step retry needs this classification
// to decide whether to throw NonRetriableError (401/403/permission/data
// errors — retrying won't fix them) or let a plain throw happen so
// Inngest's built-in backoff retries the step (connection-class errors).
// withRetry itself is gone — Inngest now owns all retry/backoff — but the
// classification logic underneath it is still needed.
export function classifySupabaseError(err: unknown): "retryable" | "not-retryable" {
  if (err instanceof TypeError) return "retryable";

  // Query-level errors come back as a return value, not a throw, so we
  // normalize them into SupabaseInsertError below. Postgres SQLSTATE class
  // 08 = connection exceptions — genuinely transient. Everything else
  // (unique constraint violations, RLS/permission denial, bad column data)
  // is a data or config problem that retrying will not fix.
  if (err instanceof SupabaseInsertError) {
    const isConnectionClassError = /fetch failed|network|ETIMEDOUT|ECONNRESET/i.test(err.message);
    return isConnectionClassError ? "retryable" : "not-retryable";
  }

  return "not-retryable";
}

/**
 * Idempotent note upsert. This is the function Phase 3's Inngest
 * orchestrator calls directly inside its own step.run(), with a noteId
 * generated in a separate, prior step.run() — so if THIS step retries
 * (transient Supabase connection failure), it reuses the same noteId and
 * upserts onto the same row instead of generating a new one and
 * duplicating the note.
 */
export async function insertNote({ runId, noteId, content }: { runId: string; noteId: string; content: string }) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from("research_notes").upsert({ id: noteId, run_id: runId, content }, { onConflict: "id" }).select("id").single();

  if (error) {
    throw new SupabaseInsertError(`Supabase upsert failed: ${error.message} (code: ${error.code ?? "unknown"})`);
  }
  return data;
}

/**
 * LEGACY AI-SDK tool wrapper. Used only by the old synchronous route
 * (app/api/research/route.ts) and ad-hoc scripts, which rely on the AI
 * SDK's own automatic tool-execution loop rather than Inngest steps.
 * Generates its own id per call — NOT idempotent against retries. This is
 * an accepted, already-documented gap (see Week 8 README's fallback-chain
 * "duplicate notes" caveat), not a new regression. Slated for deletion
 * once Phase 5 replaces route.ts with the Inngest-triggered API.
 */
export const saveNoteTool = (runId: string) =>
  tool({
    description: "Save a key finding or piece of information to persistent storage for this research session.",
    inputSchema: z.object({
      content: z.string().min(1).describe("The note content to save"),
    }),
    execute: async ({ content }) => {
      return startActiveObservation("saveNote-tool-call", async (toolSpan) => {
        toolSpan.update({ input: { content }, metadata: { toolName: "saveNote", runId } });
        try {
          const noteId = crypto.randomUUID();
          const data = await insertNote({ runId, noteId, content });
          toolSpan.update({ output: { success: true, noteId: data.id } });
          return { success: true as const, noteId: data.id };
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          toolSpan.update({ output: { success: false, error: errorMessage }, level: "ERROR" });
          return { success: false as const, error: errorMessage };
        }
      });
    },
  });
