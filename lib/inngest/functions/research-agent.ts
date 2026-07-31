// lib/inngest/functions/research-agent.ts
import { inngest } from "@/lib/inngest/client";
import { generateText, stepCountIs, tool, type ModelMessage } from "ai";
import { google } from "@ai-sdk/google";
import { webSearchInputSchema, callTavily, classifyTavilyError } from "@/lib/tools/web-search";
import { saveNoteInputSchema, insertNote, classifySupabaseError } from "@/lib/tools/save-note";
import { summarizeNotesInputSchema } from "@/lib/tools/summarize-notes";
import { doneInputSchema } from "@/lib/tools/done";
import { updateRunStatus } from "@/lib/supabase/research-runs";

const PRIMARY_MODEL = "gemini-3.1-flash-lite";
const MAX_STEPS = 8;

const SYSTEM_PROMPT = `You are a research agent. You investigate a topic, save key findings, and produce a final summary.

You have four tools:
- webSearch: search the web for information on the topic.
- saveNote: save one distinct finding at a time. Call this once per fact worth keeping, not once for a giant dump of everything.
- summarizeNotes: condense everything saved so far. Use this before calling done if you've saved several notes.
- done: call this to end the research and deliver your final answer. You MUST call done when you have gathered sufficient information, OR when you've determined no more useful information is available. Pass your complete final answer as the "summary" argument.

Rules:
- You have a hard limit of ${MAX_STEPS} steps total. Work efficiently.
- Do not call webSearch more than 2-3 times for the same topic if results aren't adding new information.
- Before retrying a failed webSearch call, check the error message. If it indicates an authorization, configuration, or service-availability problem, do NOT retry with a reworded query. Call done immediately and report the tool failure.

SOURCE LABELING — applies to every sentence in your final summary:
- Any claim from a successful webSearch result: state directly.
- Any claim NOT from a successful webSearch result MUST be prefixed with "[Unverified, from general knowledge, not from search]".
- If webSearch never returned a successful result anywhere in this run, every sentence must carry that label, or you must state plainly that no information could be retrieved.`;

const decisionTools = {
  webSearch: tool({
    description: "Search the web for current information on a topic. Returns a list of results with title, url, and snippet.",
    inputSchema: webSearchInputSchema,
  }),
  saveNote: tool({
    description: "Save a key finding or piece of information to persistent storage for this research session.",
    inputSchema: saveNoteInputSchema,
  }),
  summarizeNotes: tool({
    description: "Retrieve all saved notes for this research session and condense them into a summary.",
    inputSchema: summarizeNotesInputSchema,
  }),
  done: tool({
    description: "Call this when you have gathered and saved sufficient information to answer the research topic. This signals you are finished.",
    inputSchema: doneInputSchema,
  }),
};

interface DecisionToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

type TerminationReason = "done" | "no-tool-call" | "ceiling";

export const researchAgent = inngest.createFunction(
  {
    id: "research-agent",
    triggers: { event: "research/requested" },
  },
  async ({ event, step }) => {
    const { runId, topic } = event.data as { runId: string; topic: string };

    await step.run("mark-run-running", () => updateRunStatus(runId, { status: "running" }));

    try {
      let messages: ModelMessage[] = [{ role: "user", content: `Research topic: ${topic}` }];
      let stepCount = 0;

      let hasSearched = false;
      let hasSavedNote = false;
      let hasPaused = false;

      let finalSummary: string | null = null;
      let terminatedByDone = false;
      let terminationReason: TerminationReason | null = null;

      while (stepCount < MAX_STEPS) {
        const turnIndex = stepCount;

        const turn = await step.run(`llm-turn-${turnIndex}`, async () => {
          const r = await generateText({
            model: google(PRIMARY_MODEL),
            system: SYSTEM_PROMPT,
            messages,
            tools: decisionTools,
            stopWhen: stepCountIs(1),
          });

          return {
            text: r.text,
            finishReason: r.finishReason,
            toolCalls: r.toolCalls.map((c) => ({ toolCallId: c.toolCallId, toolName: c.toolName, input: c.input })) as DecisionToolCall[],
            responseMessages: r.finalStep.response.messages,
          };
        });

        messages = [...messages, ...(turn.responseMessages as unknown as ModelMessage[])];

        await step.run(`persist-step-count-${turnIndex}`, () => updateRunStatus(runId, { step_count: turnIndex + 1 }));

        if (turn.toolCalls.length === 0) {
          console.warn(`[research-agent:${runId}] turn ${turnIndex} ended without a tool call — instruction non-compliance.`);
          finalSummary = turn.text || null;
          terminationReason = "no-tool-call";
          break;
        }

        const doneCall = turn.toolCalls.find((c) => c.toolName === "done");

        if (doneCall) {
          const { summary } = doneCall.input as { summary: string };
          finalSummary = summary;
          terminatedByDone = true;
          terminationReason = "done";
          break;
        }

        const toolResultParts: Array<{ type: "tool-result"; toolCallId: string; toolName: string; output: { type: "json"; value: unknown } }> = [];

        for (const toolCall of turn.toolCalls) {
          let output: unknown;

          if (toolCall.toolName === "webSearch") {
            const { query } = toolCall.input as { query: string };

            output = await step.run(`tool-webSearch-${turnIndex}-${toolCall.toolCallId}`, async () => {
              try {
                const data = await callTavily(query);
                const results = (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
                if (results.length === 0) return { success: false as const, error: "No search results found for this query." };
                return { success: true as const, results };
              } catch (err) {
                const classification = classifyTavilyError(err);
                const message = err instanceof Error ? err.message : String(err);
                if (classification === "not-retryable") {
                  // Deliberately returned, NOT thrown as NonRetriableError.
                  // Throwing would crash the entire Inngest function before
                  // the model ever sees this as a tool result, defeating
                  // the system prompt's own "call done and report the
                  // failure" instruction. Returning success:false achieves
                  // the same zero-wasted-retries outcome (nothing throws,
                  // so Inngest's retry loop never triggers) while letting
                  // the model respond gracefully, matching Week 7/8's
                  // already-verified degradation behavior. Trade-off: this
                  // step shows as a plain ✅ in the dashboard, not a
                  // distinct ❌ NonRetriableError marker.
                  return { success: false as const, error: message };
                }
                throw err; // retryable — Inngest's default step retry (backoff) handles this.
              }
            });

            if ((output as { success: boolean }).success) hasSearched = true;
          } else if (toolCall.toolName === "saveNote") {
            const { content } = toolCall.input as { content: string };

            const noteId = await step.run(`generate-note-id-${turnIndex}-${toolCall.toolCallId}`, () => crypto.randomUUID());

            output = await step.run(`tool-saveNote-${turnIndex}-${toolCall.toolCallId}`, async () => {
              try {
                const note = await insertNote({ runId, noteId, content });
                return { success: true as const, noteId: note.id };
              } catch (err) {
                const classification = classifySupabaseError(err);
                const message = err instanceof Error ? err.message : String(err);
                if (classification === "not-retryable") {
                  // Same reasoning as webSearch above — return, don't throw.
                  return { success: false as const, error: message };
                }
                throw err;
              }
            });

            if ((output as { success: boolean }).success) hasSavedNote = true;
          } else if (toolCall.toolName === "summarizeNotes") {
            output = await step.run(`tool-summarizeNotes-${turnIndex}-${toolCall.toolCallId}`, async () => {
              return { success: false as const, error: "summarizeNotes not yet wired in this increment." };
            });
          } else {
            output = { success: false as const, error: `Unknown tool: ${toolCall.toolName}` };
          }

          toolResultParts.push({ type: "tool-result", toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, output: { type: "json", value: output } });
        }

        const toolMessage = { role: "tool", content: toolResultParts } as unknown as ModelMessage;
        messages = [...messages, toolMessage];

        if (hasSearched && hasSavedNote && !hasPaused) {
          hasPaused = true;

          await step.run("mark-awaiting-input", () => updateRunStatus(runId, { status: "awaiting_human_input" }));

          const humanInput = await step.waitForEvent("wait-for-human-input", {
            event: "research/human-input",
            match: "data.runId",
            timeout: "10m",
          });

          if (humanInput === null) {
            await step.run("mark-abandoned", () =>
              updateRunStatus(runId, {
                status: "abandoned",
                warning: `No human response was received within 10 minutes. The run was abandoned before summarization/completion. Partial findings may exist in research_notes for run_id ${runId}.`,
              }),
            );
            return {
              runId,
              stepCount,
              terminatedByDone: false,
              finalSummary: null,
              hasSearched,
              hasSavedNote,
              terminationReason: "abandoned" as const,
            };
          }

          const { decision, extraContext } = humanInput.data as { decision: "continue" | "add-context"; extraContext?: string };

          await step.run("mark-resumed", () => updateRunStatus(runId, { status: "running" }));

          if (decision === "add-context" && extraContext) {
            messages = [...messages, { role: "user", content: extraContext }];
          }
        }

        stepCount++;
      }

      if (terminationReason === null) terminationReason = "ceiling";

      let status: "done" | "failed";
      let warning: string | null = null;

      if (terminationReason === "done") {
        status = "done";
      } else if (terminationReason === "no-tool-call") {
        status = finalSummary ? "done" : "failed";
        warning = `The agent ended after ${stepCount} of ${MAX_STEPS} turns without calling done. This is a model compliance gap, not the step limit. ${finalSummary ? "Its final text response is included as the summary, but it was not produced via the done tool." : "No text response was produced either."}`;
      } else {
        status = "failed";
        warning = `Reached the ${MAX_STEPS}-turn limit before the agent called done. No final summary was produced. Partial findings may exist in research_notes for run_id ${runId}.`;
      }

      await step.run("persist-final-state", () =>
        updateRunStatus(runId, {
          status,
          final_summary: finalSummary,
          terminated_by_done: terminatedByDone,
          step_count: stepCount,
          warning,
        }),
      );

      return { runId, stepCount, terminatedByDone, finalSummary, hasSearched, hasSavedNote, terminationReason };
    } catch (err) {
      // Defense-in-depth for anything genuinely unexpected — a real bug,
      // Supabase unreachable in a way not otherwise classified, etc. Without
      // this, research_runs.status would stay stuck at whatever it last
      // was (usually 'running') forever, and the frontend would show an
      // indefinitely "working" run that actually died.
      const message = err instanceof Error ? err.message : String(err);
      await step
        .run("persist-unhandled-failure", () =>
          updateRunStatus(runId, {
            status: "failed",
            warning: `Run failed with an unhandled error: ${message}`,
          }),
        )
        .catch(() => {
          // If even this update fails, the original error is what matters
          // and is re-thrown below regardless.
        });
      throw err; // preserve Inngest's own function-level failure signal/observability.
    }
  },
);
