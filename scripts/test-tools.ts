import "dotenv/config";
import { webSearchTool } from "@/lib/tools/web-search";
import { saveNoteTool } from "@/lib/tools/save-note";
import { summarizeNotesTool } from "@/lib/tools/summarize-notes";
import { doneTool } from "@/lib/tools/done";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

function testOptions(toolCallId: string) {
  return { toolCallId, messages: [], context: {} };
}

async function createTestRun(topic: string): Promise<string> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from("research_runs").insert({ topic, status: "running" }).select("id").single();
  if (error || !data) throw new Error(`Failed to create test research_runs row: ${error?.message}`);
  return data.id;
}

async function main() {
  const runId = await createTestRun("test-tools.ts script run");
  console.log(`Created test research_runs row: ${runId}`);

  console.log("=== Testing webSearchTool ===");
  const searchResult = await webSearchTool.execute({ query: "current inflation rate United States" }, testOptions("test-1"));
  console.log(JSON.stringify(searchResult, null, 2));

  console.log("\n=== Testing saveNoteTool ===");
  const saveResult = await saveNoteTool(runId).execute({ content: "US inflation is currently a key economic indicator." }, testOptions("test-2"));
  console.log(JSON.stringify(saveResult, null, 2));

  console.log("\n=== Testing summarizeNotesTool (should have 1 note) ===");
  const summaryResult = await summarizeNotesTool(runId).execute({}, testOptions("test-3"));
  console.log(JSON.stringify(summaryResult, null, 2));

  console.log("\n=== Testing summarizeNotesTool against a run with NO notes (should error gracefully) ===");
  const emptyRunId = await createTestRun("test-tools.ts empty-notes run");
  const emptyResult = await summarizeNotesTool(emptyRunId).execute({}, testOptions("test-4"));
  console.log(JSON.stringify(emptyResult, null, 2));

  console.log("\n=== Testing doneTool ===");
  const doneResult = await doneTool.execute({ summary: "Test summary of findings." }, testOptions("test-5"));
  console.log(JSON.stringify(doneResult, null, 2));
}

main().catch((err) => {
  console.error("Script crashed:", err);
  process.exit(1);
});
