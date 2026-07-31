// app/api/research/[runId]/route.ts
import { NextResponse } from "next/server";
import { getRunById } from "@/lib/supabase/research-runs";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;

  // Reject non-UUID-shaped input before it ever reaches Postgres — an
  // invalid UUID passed to .eq() on a uuid column throws a Postgres
  // type error, not a clean "no rows found." Catching it here keeps the
  // 404 path uniform regardless of why the ID doesn't resolve.
  if (!UUID_RE.test(runId)) {
    return NextResponse.json({ error: "Invalid runId." }, { status: 404 });
  }

  const run = await getRunById(runId);

  if (!run) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  return NextResponse.json({
    runId: run.id,
    topic: run.topic,
    status: run.status,
    stepCount: run.step_count,
    terminatedByDone: run.terminated_by_done,
    // Only meaningful once actually done — omitting it otherwise avoids
    // the caller mistaking "not finished yet" for "produced an empty answer."
    finalSummary: run.status === "done" ? run.final_summary : null,
    // Surfaced whenever present, not only for abandoned/failed — a 'done'
    // run that ended via the no-tool-call compliance path (not a real
    // done call) also carries a warning worth showing the caller.
    warning: run.warning,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  });
}
