// scripts/test-idempotent-save.ts
// Verifies insertNote() is truly idempotent: calling it twice with the same
// noteId and content must produce exactly one row, with no error on the
// second call. This is the exact guarantee Phase 3's Inngest step retries
// depend on.
import "dotenv/config";
import { insertNote } from "@/lib/tools/save-note";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

async function main() {
  const supabase = createSupabaseAdminClient();

  const { data: run, error: runError } = await supabase.from("research_runs").insert({ topic: "idempotency test", status: "running" }).select("id").single();
  if (runError || !run) throw new Error(`Failed to create test run: ${runError?.message}`);

  const runId = run.id;
  const noteId = crypto.randomUUID();
  const content = "Idempotency test note — should appear exactly once.";

  console.log(`Test run: ${runId}, noteId: ${noteId}`);

  console.log("\n=== First call ===");
  console.log(JSON.stringify(await insertNote({ runId, noteId, content }), null, 2));

  console.log("\n=== Second call — same noteId, same content ===");
  console.log(JSON.stringify(await insertNote({ runId, noteId, content }), null, 2));

  const { data: rows, error: countError } = await supabase.from("research_notes").select("id").eq("id", noteId);
  if (countError) throw new Error(`Failed to verify row count: ${countError.message}`);

  console.log(`\nRows with id=${noteId}: ${rows?.length}`);
  if (rows?.length === 1) {
    console.log("PASS: exactly one row exists after two identical upserts.");
  } else {
    console.error(`FAIL: expected exactly 1 row, found ${rows?.length}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Script crashed:", err);
  process.exit(1);
});
