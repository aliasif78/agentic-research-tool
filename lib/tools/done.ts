// lib/tools/done.ts
import { z } from "zod";

export const doneInputSchema = z.object({
  summary: z.string().min(1).describe("Final summary of findings to present to the user"),
});
