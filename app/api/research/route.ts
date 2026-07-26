// app/api/research/route.ts
import { NextResponse } from "next/server";
import { generateText, stepCountIs, hasToolCall } from "ai";
import { google } from "@ai-sdk/google";
import { webSearchTool } from "@/lib/tools/web-search";
import { saveNoteTool } from "@/lib/tools/save-note";
import { summarizeNotesTool } from "@/lib/tools/summarize-notes";
import { doneTool } from "@/lib/tools/done";

// Multi-step agent loops can run long — don't let this silently inherit a
// default Vercel function timeout shorter than a real 8-step run needs.
// Tune this number in Phase 4 once you've measured actual run duration.
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_STEPS = 8;

const SYSTEM_PROMPT = `You are a research agent. You investigate a topic, save key findings, and produce a final summary.

You have four tools:
- webSearch: search the web for information on the topic.
- saveNote: save one distinct finding at a time. Call this once per fact worth keeping, not once for a giant dump of everything.
- summarizeNotes: condense everything saved so far. Use this before calling done if you've saved several notes.
- done: call this to end the research and deliver your final answer. You MUST call done when you have gathered sufficient information, OR when you've determined no more useful information is available (e.g. repeated searches return nothing relevant). Pass your complete final answer as the "summary" argument — this is the only text the user will see. The run ends the instant done is called; there is no further step where you can add more text.

Rules:
- You have a hard limit of ${MAX_STEPS} steps total. Work efficiently.
- Do not call webSearch more than 2-3 times for the same topic if results aren't adding new information. If searches keep returning nothing new or nothing relevant, call done and say so honestly in your summary — do not keep searching hoping for a different result.
- If a tool returns { success: false, error }, do not retry the identical call with identical arguments. Either adjust your approach (e.g. reworded search query) or call done and report the limitation.
- Never fabricate findings. If information isn't in your search results or saved notes, say so in your summary rather than inventing something.`;

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

  // Generated server-side, never accepted from the client. Nothing here
  // lets a caller supply an arbitrary sessionId to read or write another
  // session's notes via the admin client. This is NOT multi-tenant auth
  // (that's Week 9 / capstone) — it just closes the "guess someone else's
  // session id" gap that existed when sessionId was purely a closure param
  // with an unstated origin.
  const sessionId = crypto.randomUUID();

  const stepLog: Array<{
    step: number;
    toolCalls: unknown;
    toolResults: unknown;
    usage: unknown;
  }> = [];

  try {
    const result = await generateText({
      model: google("gemini-3.1-flash-lite"),
      system: SYSTEM_PROMPT,
      prompt: `Research topic: ${topic}`,
      tools: {
        webSearch: webSearchTool,
        saveNote: saveNoteTool(sessionId),
        summarizeNotes: summarizeNotesTool(sessionId),
        done: doneTool,
      },
      // Stops on whichever condition fires first: hard step ceiling, or the
      // model explicitly signaling completion via the `done` tool.
      stopWhen: [stepCountIs(MAX_STEPS), hasToolCall("done")],
      onStepFinish: ({ stepNumber, toolCalls, toolResults, usage }) => {
        stepLog.push({ step: stepNumber, toolCalls, toolResults, usage });
        // VERIFY: field name is `input` on tool calls in your installed
        // version (v5+ renamed `args` -> `input`; confirm against .d.ts).
        console.log(`[research:${sessionId}] step ${stepNumber}`, {
          toolCalls: toolCalls.map((c) => ({ name: c.toolName, input: c.input })),
          toolResults,
          usage,
        });
      },
    });

    const lastStep = result.steps[result.steps.length - 1];
    const doneCall = lastStep?.toolCalls?.find((c) => c.toolName === "done");

    const outerUsage = stepLog.reduce(
      (acc, s) => {
        const u = s.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
        return {
          inputTokens: acc.inputTokens + (u?.inputTokens ?? 0),
          outputTokens: acc.outputTokens + (u?.outputTokens ?? 0),
          totalTokens: acc.totalTokens + (u?.totalTokens ?? 0),
        };
      },
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    );

    console.log(`[research:${sessionId}] run complete`, {
      steps: result.steps.length,
      terminatedByDone: Boolean(doneCall),
      outerUsage, // NOTE: does not include nested summarizeNotes LLM calls — see below
    });

    if (doneCall) {
      const { summary } = doneCall.input as { summary: string };
      return NextResponse.json({
        sessionId,
        summary,
        terminatedByDone: true,
        steps: result.steps.length,
        usage: outerUsage,
      });
    }

    // Step ceiling hit without `done` being called. Not a crash, not a
    // silent hang — this is the exact case Phase 4 test #3 needs to hit.
    // Deliberately do NOT make one more model call here to "wrap up" —
    // that would defeat the ceiling you just enforced.
    return NextResponse.json({
      sessionId,
      summary: null,
      terminatedByDone: false,
      steps: result.steps.length,
      usage: outerUsage,
      warning: `Reached the ${MAX_STEPS}-step limit before the agent called done. No final summary was produced. Partial findings may exist in research_notes for sessionId ${sessionId}.`,
    });
  } catch (err) {
    console.error(`[research:${sessionId}] run failed`, err);
    return NextResponse.json(
      {
        sessionId,
        error: "Research run failed before completion.",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}
