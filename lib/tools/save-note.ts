// lib/tools/save-note.ts
import { tool } from "ai";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const saveNoteTool = (sessionId: string) =>
  tool({
    description: "Save a key finding or piece of information to persistent storage for this research session.",
    inputSchema: z.object({
      content: z.string().min(1).describe("The note content to save"),
    }),
    execute: async ({ content }) => {
      try {
        const supabase = await createSupabaseServerClient();
        const { data, error } = await supabase.from("research_notes").insert({ session_id: sessionId, content }).select("id").single();

        if (error) {
          return { success: false as const, error: `Supabase insert failed: ${error.message}` };
        }

        return { success: true as const, noteId: data.id };
      } catch (err) {
        return {
          success: false as const,
          error: `Save note failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });
