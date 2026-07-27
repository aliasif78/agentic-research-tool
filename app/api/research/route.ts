// app/api/research/route.ts

import { NextResponse } from "next/server";
import { generateText, stepCountIs, hasToolCall } from "ai";
import { google } from "@ai-sdk/google";
import { propagateAttributes } from "@langfuse/tracing";
import { webSearchTool } from "@/lib/tools/web-search";
import { saveNoteTool } from "@/lib/tools/save-note";
import { summarizeNotesTool } from "@/lib/tools/summarize-notes";
import { doneTool } from "@/lib/tools/done";
import { generateWithFallback } from "@/lib/models/generate-with-fallback";

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
- Do not call webSearch more than 2-3 times for the same topic if results aren't adding new information. If searches keep returning nothing new or nothing relevant, call done and say so.
- Before retrying a failed webSearch call, check the error message. If it indicates an authorization, configuration, or service-availability problem (e.g. "Unauthorized", "invalid API key", "503", "timed out"), do NOT retry with a reworded query — that class of error is not fixable by changing your input. Call done immediately and report the tool failure.

SOURCE LABELING — this is not optional and applies to every sentence in your final summary:
- Any claim that came from a successful webSearch result: state it directly, no label needed.
- Any claim that did NOT come from a successful webSearch result — meaning it comes from your own training data because search failed, returned nothing relevant, or was never called — MUST be prefixed with "[Unverified, from general knowledge, not from search]" on that sentence or bullet point. Do not put a single disclaimer at the top of your summary and then state unlabeled claims below it. Every individual unverified claim needs its own label, immediately before it.
- If webSearch never returned a successful result anywhere in this run, your summary must not contain any unlabeled substantive claims. Every sentence of content must carry the "[Unverified, from general knowledge, not from search]" label, or you must state plainly that no information could be retrieved and stop there — do not pad the response with unlabeled background knowledge.
- Never fabricate a webSearch result. If you did not call the tool or it did not succeed, you have no search result to draw from, full stop.`;

async function flushLangfuse() {
  const spanProcessor = (globalThis as { __langfuseSpanProcessor?: { forceFlush: () => Promise<void> } }).__langfuseSpanProcessor;
  if (spanProcessor) {
    await spanProcessor.forceFlush();
  }
}

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

  // Every span produced inside this callback — webSearch/saveNote retry
  // attempts, model-call generations, fallback-trigger events — is tagged
  // with this sessionId, so the Langfuse dashboard groups an entire
  // research run (including nested summarizeNotes LLM calls) into one
  // session view, matching how research_notes is already scoped.
  return propagateAttributes({ sessionId }, async () => {
    const stepLog: Array<{
      step: number;
      toolCalls: unknown;
      toolResults: unknown;
      usage: unknown;
    }> = [];

    try {
      const { result, modelUsed, fallbackTriggered, primaryError } = await generateWithFallback((modelId) => {
        return generateText({
          model: google(modelId),
          system: SYSTEM_PROMPT,
          prompt: `Research topic: ${topic}`,
          maxRetries: 3, // AI SDK's own retryWithExponentialBackoff — exhausted
          // before generateWithFallback ever sees an error.
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
            console.log(
              `[research:${sessionId}] step ${stepNumber}`,
              JSON.stringify(
                {
                  toolCalls: toolCalls.map((c) => ({ name: c.toolName, input: c.input })),
                  toolResults,
                  usage,
                },
                null,
                2,
              ),
            );
          },
        });
      });

      if (fallbackTriggered) {
        console.warn(`[research:${sessionId}] primary model (gemini-3.1-flash-lite) failed, fell back to gemini-3.5-flash`, { primaryError });
      }

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

      console.log(
        `[research:${sessionId}] run complete`,
        JSON.stringify(
          {
            steps: result.steps.length,
            terminatedByDone: Boolean(doneCall),
            modelUsed,
            fallbackTriggered,
            outerUsage, // NOTE: does not include nested summarizeNotes LLM calls — see below
          },
          null,
          2,
        ),
      );

      const costNote = `Authoritative token and cost totals for this run — including the nested summarizeNotes LLM call — are tracked in Langfuse under sessionId ${sessionId}, not in this response. A partial outerUsage figure was previously exposed here and was incomplete by construction; removed rather than fixed a second time.`;

      if (doneCall) {
        const { summary } = doneCall.input as { summary: string };
        await flushLangfuse();
        return NextResponse.json({ sessionId, summary, terminatedByDone: true, steps: result.steps.length, costNote, modelUsed, fallbackTriggered });
      }

      // No `done` call. Two distinct causes — do not conflate them:
      const hitStepCeiling = result.steps.length >= MAX_STEPS;

      if (!hitStepCeiling) {
        // Model stopped on its own (plain text finish) without calling `done`,
        // despite being told it MUST. This is a compliance failure, not a
        // ceiling event — the message must say so, and result.text (if any)
        // should be surfaced rather than discarded.
        console.warn(`[research:${sessionId}] model ended without calling done at step ${result.steps.length}/${MAX_STEPS} — instruction non-compliance, not a ceiling hit.`);
        await flushLangfuse();
        return NextResponse.json({
          sessionId,
          summary: result.text || null,
          terminatedByDone: false,
          steps: result.steps.length,
          costNote,
          modelUsed,
          fallbackTriggered,
          warning: `The agent ended after ${result.steps.length} of ${MAX_STEPS} steps without calling done. This is a model compliance gap, not the step limit. ${result.text ? "Its final text response is included as summary, but it was not produced via the done tool and has not gone through your source-labeling or termination logic." : "No text response was produced either."}`,
        });
      }

      // Genuine ceiling hit.
      await flushLangfuse();
      return NextResponse.json({
        sessionId,
        summary: null,
        terminatedByDone: false,
        steps: result.steps.length,
        costNote,
        modelUsed,
        fallbackTriggered,
        warning: `Reached the ${MAX_STEPS}-step limit before the agent called done. No final summary was produced. Partial findings may exist in research_notes for sessionId ${sessionId}.`,
      });
    } catch (err) {
      const modelUsed = (err as { modelUsed?: string | null }).modelUsed ?? null;
      const fallbackTriggered = (err as { fallbackTriggered?: boolean }).fallbackTriggered ?? false;

      console.error(`[research:${sessionId}] run failed`, { modelUsed, fallbackTriggered, error: err });
      await flushLangfuse();
      return NextResponse.json(
        {
          sessionId,
          error: "Research run failed before completion.",
          detail: err instanceof Error ? err.message : String(err),
          modelUsed,
          fallbackTriggered,
        },
        { status: 502 },
      );
    }
  });
}
