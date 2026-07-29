// lib/inngest/functions/research-agent.ts
import { inngest } from "@/lib/inngest/client";
import { generateText, stepCountIs, tool, type ModelMessage } from "ai";
import { google } from "@ai-sdk/google";
import { webSearchInputSchema, callTavily } from "@/lib/tools/web-search";
import { saveNoteInputSchema, insertNote } from "@/lib/tools/save-note";
import { summarizeNotesInputSchema } from "@/lib/tools/summarize-notes";
import { doneInputSchema } from "@/lib/tools/done";

const PRIMARY_MODEL = "gemini-3.1-flash-lite";
const MAX_STEPS = 8; // unchanged from the old route — see Phase 7 for re-measurement before touching this number.

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

// Schema-only "decision" tools — deliberately NO execute function. If these
// had execute, the AI SDK would auto-run them inside this same generateText
// call, collapsing tool execution back into one opaque Inngest step and
// defeating per-tool step boundaries entirely. Descriptions are duplicated
// from lib/tools/* on purpose — kept in sync manually.
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

export const researchAgent = inngest.createFunction(
  {
    id: "research-agent",
    triggers: { event: "research/requested" },
  },
  async ({ event, step }) => {
    const { runId, topic } = event.data as { runId: string; topic: string };

    let messages: ModelMessage[] = [{ role: "user", content: `Research topic: ${topic}` }];
    let stepCount = 0;
    let hasSearched = false;
    let hasSavedNote = false;
    let finalSummary: string | null = null;
    let terminatedByDone = false;

    while (stepCount < MAX_STEPS) {
      const turnIndex = stepCount;

      // --- One model turn = one Inngest step ---
      const turn = await step.run(`llm-turn-${turnIndex}`, async () => {
        const r = await generateText({
          model: google(PRIMARY_MODEL),
          system: SYSTEM_PROMPT,
          messages,
          tools: decisionTools,
          stopWhen: stepCountIs(1),
        });

        // Hand-built plain return value, not the raw SDK result — Inngest
        // serializes step.run() returns for checkpointing, so anything
        // returned here comes back on the other side typed as
        // JsonifyObject<...>, not the original AI SDK types. That's
        // expected and fine; the cast back to ModelMessage[] below at the
        // point of use is deliberate, not a type-safety shortcut.
        // r.response is deprecated in this AI SDK version in favor of
        // r.finalStep.response — since stopWhen: stepCountIs(1) guarantees
        // exactly one step, finalStep IS this step.
        return {
          text: r.text,
          finishReason: r.finishReason,
          toolCalls: r.toolCalls.map((c) => ({ toolCallId: c.toolCallId, toolName: c.toolName, input: c.input })) as DecisionToolCall[],
          responseMessages: r.finalStep.response.messages,
        };
      });

      // Cast at the step.run() boundary: turn.responseMessages has already
      // round-tripped through JSON (Inngest's checkpointing), so its type
      // is a JSON-degraded shape, not the AI SDK's exact ModelMessage type.
      // We know these values are structurally valid ModelMessages because
      // we just extracted them unmodified from a real generateText call —
      // the assertion documents that known-safe assumption, it doesn't
      // paper over any real data risk.
      messages = [...messages, ...(turn.responseMessages as unknown as ModelMessage[])];

      if (turn.toolCalls.length === 0) {
        console.warn(`[research-agent:${runId}] turn ${turnIndex} ended without a tool call — instruction non-compliance.`);
        finalSummary = turn.text || null;
        break;
      }

      const doneCall = turn.toolCalls.find((c) => c.toolName === "done");

      if (doneCall) {
        // Known simplification: if the model batches `done` with other
        // tool calls in the same turn, those other calls are NOT executed.
        // done signals explicit termination intent, treated as authoritative.
        const { summary } = doneCall.input as { summary: string };
        finalSummary = summary;
        terminatedByDone = true;
        break;
      }

      // --- Each tool call in this turn = its own separate Inngest step ---
      const toolResultParts: Array<{ type: "tool-result"; toolCallId: string; toolName: string; output: { type: "json"; value: unknown } }> = [];

      for (const toolCall of turn.toolCalls) {
        let output: unknown;

        if (toolCall.toolName === "webSearch") {
          const { query } = toolCall.input as { query: string };
          output = await step.run(`tool-webSearch-${turnIndex}-${toolCall.toolCallId}`, async () => {
            // TODO Phase 3 (next increment): classify Tavily errors and
            // throw NonRetriableError for 401/403/400.
            const data = await callTavily(query);
            const results = (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
            if (results.length === 0) return { success: false as const, error: "No search results found for this query." };
            hasSearched = true;
            return { success: true as const, results };
          });
        } else if (toolCall.toolName === "saveNote") {
          const { content } = toolCall.input as { content: string };
          // TODO Phase 3 (next increment): noteId must be generated in its
          // OWN step.run() so a retry of the insert step reuses the same id.
          const noteId = crypto.randomUUID();
          output = await step.run(`tool-saveNote-${turnIndex}-${toolCall.toolCallId}`, async () => {
            const note = await insertNote({ runId, noteId, content });
            hasSavedNote = true;
            return { success: true as const, noteId: note.id };
          });
        } else if (toolCall.toolName === "summarizeNotes") {
          output = await step.run(`tool-summarizeNotes-${turnIndex}-${toolCall.toolCallId}`, async () => {
            // Placeholder for this increment — decoupled nested
            // generateText + fallback-chain call deferred.
            return { success: false as const, error: "summarizeNotes not yet wired in this increment." };
          });
        } else {
          output = { success: false as const, error: `Unknown tool: ${toolCall.toolName}` };
        }

        toolResultParts.push({ type: "tool-result", toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, output: { type: "json", value: output } });
      }

      // Same deliberate boundary cast as above: this object is built fresh,
      // right here, not round-tripped through step.run() — but its `output`
      // fields carry `unknown` values (since tool outputs are dynamically
      // shaped), so it can't structurally satisfy ModelMessage's strict
      // ToolResultOutput["value"]: JSONValue typing without this assertion.
      // Every value pushed into toolResultParts above is plain JSON
      // (booleans, strings, arrays, plain objects) by construction.
      const toolMessage = { role: "tool", content: toolResultParts } as unknown as ModelMessage;
      messages = [...messages, toolMessage];
      stepCount++;
    }

    await step.run("log-final-state", async () => {
      // TODO Phase 3 step 6 (next increment): persist to research_runs.
      console.log(`[research-agent:${runId}] loop finished`, { stepCount, terminatedByDone, finalSummary, hasSearched, hasSavedNote });
    });

    return { runId, stepCount, terminatedByDone, finalSummary, hasSearched, hasSavedNote };
  },
);
