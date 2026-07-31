// app/api/research/route.ts

import { NextResponse } from "next/server";
import { inngest } from "@/lib/inngest/client";
import { createRun, updateRunStatus } from "@/lib/supabase/research-runs";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { topic?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const topic = body.topic?.trim();
  if (!topic) {
    return NextResponse.json({ error: "Missing required field: topic." }, { status: 400 });
  }

  const run = await createRun(topic);

  try {
    await inngest.send({ name: "research/requested", data: { runId: run.id, topic } });
  } catch (err) {
    // The row exists but nothing will ever process it. Mark it failed
    // rather than leaving a permanently-stuck 'pending' row with no
    // explanation — kept, not deleted, so the failure is visible in
    // Supabase rather than silently erased.
    const message = err instanceof Error ? err.message : String(err);
    await updateRunStatus(run.id, { status: "failed", warning: `Failed to enqueue research run: ${message}` }).catch(() => {
      // If even this update fails, the original error is already what
      // matters to the caller — nothing further to do here.
    });
    return NextResponse.json({ error: "Failed to start research run." }, { status: 500 });
  }

  // CONTRACT BREAK from the old synchronous route: this returns
  // immediately with only a runId — no summary, no step count, no
  // completion status. The caller must poll GET /api/research/[runId]
  // to observe progress and retrieve the eventual result.
  return NextResponse.json({ runId: run.id }, { status: 202 });
}
