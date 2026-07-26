# Agentic Research Tool — Week 7 (Agent Architecture Fundamentals)

A ReAct-style research agent: given a topic, it searches the web, saves findings, optionally condenses them, and produces a final grounded summary. Built to stress-test agent termination reliability, not to be a polished product — see "What this is not" below.

## Architecture

Single API route (`app/api/research/route.ts`), no frontend. `POST { topic: string }` runs a tool-calling loop via the Vercel AI SDK's `generateText` with four tools:

- **`webSearch`** — Tavily API, 10s timeout via `AbortSignal.timeout`.
- **`saveNote`** — writes one finding at a time to `research_notes` in Supabase, scoped by a server-generated `sessionId` (never accepted from the client — see Security below).
- **`summarizeNotes`** — a _nested_ `generateText` call that condenses saved notes. This is a hidden LLM call inside a tool; see Cost below for why that matters.
- **`done`** — the model's explicit termination signal. Its `summary` argument is the only text the user ever sees, since the loop ends the instant `done` is called (no further generation step exists to add anything).

### Termination

`stopWhen: [stepCountIs(8), hasToolCall("done")]` — the loop ends on whichever fires first. The route distinguishes **three**, not two, exit states:

1. `done` was called → return its `summary`, `terminatedByDone: true`.
2. The model stopped generating tool calls on its own, without calling `done`, before the step ceiling — a **compliance failure**, not a ceiling event. The route surfaces `result.text` (if any) and flags it explicitly as not having gone through the `done` schema or been validated by the loop's termination logic.
3. The step ceiling (8) was reached with no `done` call — `summary: null`, explicit warning naming the ceiling, no crash, no hang.

These are logged and returned differently on purpose. Collapsing (2) and (3) into one "didn't finish" bucket was an actual bug caught during testing (see Known Limitations).

## Known Limitations (measured, not assumed)

**`done` compliance is ~80%, not 100%, despite an explicit "MUST call done" system prompt instruction.**
Measured on N=10 identical requests against a dead search API: 8/10 runs terminated via `done`; 2/10 ended via early plain-text finish (state 2 above). This is the same category of gap as the RAG project's confidence-threshold limitation — a soft instruction with a non-zero, measured failure rate and no code-level guarantee. The step-ceiling backstop (state 3) exists precisely because this instruction cannot be trusted at 100%. Sample size is small; treat 80% as a rough baseline, not a precise figure, until re-tested at N=20+.

**Cost is a range, not a single number, and requires manual aggregation.**

- Fast-fail runs (search unavailable, agent gives up in ~2 steps): ~1,700–2,900 total tokens, 1 LLM call.
- Real multi-step runs: one fully-traced 6-step run cost 12,754 tokens by the route's own `outerUsage` counter — **but the true total is 13,009**, because `outerUsage` does not include the nested `summarizeNotesTool` call (logged separately, 255 tokens). Any run calling `summarizeNotes` more than once will widen this gap further. There is currently no single log line giving a true per-run total; it must be computed by hand from two separate console outputs.
- Per-step cost is not flat: input tokens grew from 824 to 2,527 across one 6-step run because full conversation history is resent every step. An 8-step ceiling costs meaningfully more than "8× a single step."

**Source labeling holds under failure, but is an instruction, not a code guarantee.**
System prompt requires every claim not grounded in a successful `webSearch` result to be prefixed `[Unverified, from general knowledge, not from search]`. Verified across multiple failure-mode runs, including a mixed case where the model correctly labeled only the ungrounded claims in a partially-successful research run (traced against actual search result content, not just format-checked). Held 10/10 in testing, including in both non-`done` compliance-failure runs. No code-level enforcement exists — same structural category as the `done`-compliance gap and the RAG project's threshold limitation.

**Tool error handling is graceful, but not differentiated by error type.**
A dead API key, a timeout, and a malformed input all currently surface to the model as the same shape (`{ success: false, error: string }`). Tested directly with a real revoked Tavily key across 12+ runs: zero 500s, zero stack traces reached the client, zero unhandled exceptions. But the model has no structured way to distinguish "retryable" from "not retryable" beyond parsing the error string itself — confirmed working via prompt instruction (the model correctly avoided retrying on an "Unauthorized" error after this was added), but this is pattern-matching on English text, not a structured signal.

**Not yet tested: the step ceiling under organic multi-step growth.**
The ceiling was verified mechanically by temporarily lowering `MAX_STEPS` to 2 — this proves the stop condition fires correctly, but no run has yet organically reached step 8 through real tool-calling behavior. Whether 8 is actually the right number for genuinely broad topics (vs. cutting off a run that was one step from concluding) is unmeasured.

## What this is not

No frontend. This was deliberate, not an oversight — see the conversation this README was extracted from for the reasoning, but in short: testing termination reliability via raw `curl` and structured JSON responses surfaces failure states (`terminatedByDone: false`, compliance gaps) that a chat UI would visually smooth over. Building a frontend before the agent's termination behavior was actually measured would have hidden exactly the problems this exercise exists to find. A frontend is a prerequisite for treating this as a portfolio piece, not for finishing Week 7's exercise — it isn't built yet.

No retry/backoff on tool failures (Week 8 territory). No structured observability beyond `console.log` (also Week 8 — this README's cost and compliance figures were extracted by hand from raw logs, which is exactly the manual-aggregation problem Langfuse is meant to solve). No multi-tenant auth — `sessionId` is server-generated per request specifically so a client can't guess another session's ID, but there's no user-account layer restricting who can start a session at all.

## Environment Variables

```
TAVILY_API_KEY
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
GOOGLE_GENERATIVE_AI_API_KEY
```

## Running

```bash
npm run dev
curl -X POST http://localhost:3000/api/research \
  -H "Content-Type: application/json" \
  -d '{"topic": "your topic here"}'
```
