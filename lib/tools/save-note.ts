// lib/tools/save-note.ts
import { tool } from "ai";
import { z } from "zod";
import { startActiveObservation } from "@langfuse/tracing";
import { createSupabaseAdminClient } from "../supabase/admin-client";
import { withRetry, type RetryClassification } from "@/lib/retry";

export class SupabaseInsertError extends Error {}

export function classifySupabaseError(err: unknown): RetryClassification {
  // Supabase-js throws a raw TypeError for actual network failures (fetch
  // itself couldn't reach the host) — that's transient, worth a retry.
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

export const saveNoteTool = (sessionId: string) =>
  tool({
    description: "Save a key finding or piece of information to persistent storage for this research session.",
    inputSchema: z.object({
      content: z.string().min(1).describe("The note content to save"),
    }),
    execute: async ({ content }) => {
      return startActiveObservation("saveNote-tool-call", async (toolSpan) => {
        toolSpan.update({ input: { content }, metadata: { toolName: "saveNote", sessionId } });

        const supabase = createSupabaseAdminClient();

        async function insertOnce() {
          const { data, error } = await supabase.from("research_notes").insert({ session_id: sessionId, content }).select("id").single();
          if (error) {
            throw new SupabaseInsertError(`Supabase insert failed: ${error.message} (code: ${error.code ?? "unknown"})`);
          }
          return data;
        }

        try {
          const {
            result: data,
            attempts,
            attemptLog,
          } = await withRetry(insertOnce, {
            maxAttempts: 3,
            baseDelayMs: 400,
            maxDelayMs: 3000,
            classify: classifySupabaseError,
            onAttempt: (log) => {
              const attemptSpan = toolSpan.startObservation(`saveNote-attempt-${log.attempt}`, {
                input: { attemptNumber: log.attempt },
                metadata: { classification: log.classification },
              });
              attemptSpan.update({ output: { errorMessage: log.errorMessage, delayMs: log.delayMs } });
              attemptSpan.end();
            },
          });

          toolSpan.update({ output: { success: true, noteId: data.id, attempts } });
          return { success: true as const, noteId: data.id, attempts, attemptLog };
        } catch (err) {
          const attemptLog = (err as { attemptLog?: unknown }).attemptLog;
          const errorMessage = err instanceof Error ? err.message : String(err);
          toolSpan.update({ output: { success: false, error: errorMessage }, level: "ERROR" });
          return { success: false as const, error: errorMessage, attemptLog };
        }
      });
    },
  });
