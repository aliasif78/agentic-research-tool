import "dotenv/config";
import { webSearchTool } from "@/lib/tools/web-search";
import { saveNoteTool } from "@/lib/tools/save-note";
import { summarizeNotesTool } from "@/lib/tools/summarize-notes";
import { doneTool } from "@/lib/tools/done";

const TEST_SESSION_ID = `test-${Date.now()}`;

function testOptions(toolCallId: string) {
  return { toolCallId, messages: [], context: {} };
}

async function main() {
  console.log("=== Testing webSearchTool ===");
  const searchResult = await webSearchTool.execute({ query: "current inflation rate United States" }, testOptions("test-1"));
  console.log(JSON.stringify(searchResult, null, 2));

  console.log("\n=== Testing saveNoteTool ===");
  const saveResult = await saveNoteTool(TEST_SESSION_ID).execute({ content: "US inflation is currently a key economic indicator." }, testOptions("test-2"));
  console.log(JSON.stringify(saveResult, null, 2));

  console.log("\n=== Testing summarizeNotesTool (should have 1 note) ===");
  const summaryResult = await summarizeNotesTool(TEST_SESSION_ID).execute({}, testOptions("test-3"));
  console.log(JSON.stringify(summaryResult, null, 2));

  console.log("\n=== Testing summarizeNotesTool with EMPTY session (should error gracefully) ===");
  const emptyResult = await summarizeNotesTool(`empty-${Date.now()}`).execute({}, testOptions("test-4"));
  console.log(JSON.stringify(emptyResult, null, 2));

  console.log("\n=== Testing doneTool ===");
  const doneResult = await doneTool.execute({ summary: "Test summary of findings." }, testOptions("test-5"));
  console.log(JSON.stringify(doneResult, null, 2));
}

main().catch((err) => {
  console.error("Script crashed:", err);
  process.exit(1);
});
