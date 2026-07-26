// lib/tools/summarize-notes.ts
import { tool } from "ai";
import { z } from "zod";
import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { createSupabaseAdminClient } from "../supabase/admin-client";

export const summarizeNotesTool = (sessionId: string) =>
  tool({
    description: "Retrieve all saved notes for this research session and condense them into a summary.",
    inputSchema: z.object({}),
    execute: async () => {
      const supabase = createSupabaseAdminClient();
      const { data, error } = await supabase.from("research_notes").select("content").eq("session_id", sessionId).order("created_at", { ascending: true });

      if (error) {
        return { success: false as const, error: `Failed to retrieve notes: ${error.message}` };
      }

      if (!data || data.length === 0) {
        return { success: false as const, error: "No notes have been saved yet for this session." };
      }

      const notesText = data.map((n, i) => `${i + 1}. ${n.content}`).join("\n");

      try {
        const { text } = await generateText({
          model: google("gemini-3.1-flash-lite"),
          prompt: `Condense the following research notes into a concise summary, preserving all key facts:\n\n${notesText}`,
        });

        return { success: true as const, summary: text };
      } catch (err) {
        return {
          success: false as const,
          error: `Summarization call failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });
