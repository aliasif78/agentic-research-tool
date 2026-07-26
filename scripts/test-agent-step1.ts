// scripts/test-agent-step1.ts
import { config } from "dotenv";
config({ path: ".env.local" });

import { generateText, stepCountIs } from "ai";
import { google } from "@ai-sdk/google";
import { webSearchTool } from "@/lib/tools/web-search";

async function main() {
  const result = await generateText({
    model: google("gemini-3.1-flash-lite"),
    tools: { webSearch: webSearchTool },
    stopWhen: stepCountIs(3), // allow: tool call step -> follow-up text step, with headroom
    prompt: "What is the current US inflation rate? Use the webSearch tool to find out, then answer in one sentence citing the number.",
  });

  console.log("=== Final text ===");
  console.log(result.text);

  console.log("\n=== Steps taken ===");
  console.log(result.steps.length);

  console.log("\n=== Full step detail ===");
  for (const [i, step] of result.steps.entries()) {
    console.log(`\n--- Step ${i + 1} ---`);
    console.log("Tool calls:", JSON.stringify(step.toolCalls, null, 2));
    console.log("Tool results:", JSON.stringify(step.toolResults, null, 2));
    console.log("Text:", step.text);
    console.log("Finish reason:", step.finishReason);
  }
}

main().catch((err) => {
  console.error("Script crashed:", err);
  process.exit(1);
});
