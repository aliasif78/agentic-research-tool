// app/api/research/[runId]/resume/route.ts
import { NextResponse } from "next/server";
import { inngest } from "@/lib/inngest/client";
import { getRunById } from "@/lib/supabase/research-runs";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;

  if (!UUID_RE.test(runId)) {
    return NextResponse.json({ error: "Invalid runId." }, { status: 404 });
  }

  let body: { decision?: string; extraContext?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { decision, extraContext } = body;

  if (decision !== "continue" && decision !== "add-context") {
    return NextResponse.json({ error: 'decision must be "continue" or "add-context".' }, { status: 400 });
  }

  // Closes a latent gap in the agent function: it silently treats
  // add-context with no extraContext as if it were continue. Reject it
  // here instead, at the API boundary, rather than letting bad input
  // through to be misinterpreted downstream.
  if (decision === "add-context" && !extraContext?.trim()) {
    return NextResponse.json({ error: 'extraContext is required and must be non-empty when decision is "add-context".' }, { status: 400 });
  }

  const run = await getRunById(runId);

  if (!run) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  // Explicit state check — do not let a resume signal fire into the void.
  // A run that's already done, already abandoned, or never reached the
  // checkpoint has no live step.waitForEvent() to receive this event; it
  // would just be silently dropped. Small, accepted race: status could
  // theoretically flip between this check and the send below (e.g. the
  // 10-minute timeout landing in that exact window) — not solved here,
  // not worth locking for this exercise's scale.
  if (run.status !== "awaiting_human_input") {
    return NextResponse.json({ error: `Run is not awaiting human input (current status: ${run.status}).` }, { status: 409 });
  }

  try {
    await inngest.send({
      name: "research/human-input",
      data: { runId, decision, ...(extraContext ? { extraContext: extraContext.trim() } : {}) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to send resume signal: ${message}` }, { status: 502 });
  }

  return NextResponse.json({ runId, message: "Resume signal sent." }, { status: 202 });
}
