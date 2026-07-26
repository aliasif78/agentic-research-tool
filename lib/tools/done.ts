// lib/tools/done.ts
import { tool } from "ai";
import { z } from "zod";

export const doneTool = tool({
  description: "Call this when you have gathered and saved sufficient information to answer the research topic. This signals you are finished.",
  inputSchema: z.object({
    summary: z.string().min(1).describe("Final summary of findings to present to the user"),
  }),
  execute: async ({ summary }) => {
    return { success: true as const, summary };
  },
});
