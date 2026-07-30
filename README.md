# Agentic Research Tool — Week 9 (Durable, Resumable Agent on Inngest)

A ReAct-style research agent — search, save findings, pause once for a human decision, resume, summarize, terminate — rebuilt on Inngest so the entire run survives process crashes, retries individual tool failures without re-running completed work, and durably waits (real minutes, not an open HTTP connection) for a human response mid-run. Weeks 7–8 built and hardened the agent as a single synchronous API call. Week 9 is not an incremental feature added on top of that — it's a different execution model, and getting there required finding and fixing several real correctness bugs along the way, documented below rather than glossed over.

## Architecture

One Inngest function, `research-agent` (`lib/inngest/functions/research-agent.ts`), triggered by a `research/requested` event carrying `{ runId, topic }`. Everything downstream — the trigger, status, and resume HTTP routes, and the frontend — talks to this function only through Supabase (`research_runs`, `research_notes`) and Inngest events. There is no synchronous request/response path anymore; see "Contract break" below.

### The core tradeoff: hand-rolled loop vs. the AI SDK's own multi-step loop

Weeks 7–8's agent used `generateText`'s **internal** multi-step tool-calling loop (`stopWhen: [stepCountIs(8), hasToolCall("done")]`) — the AI SDK managed the whole turn-by-turn loop, tool execution, and message history inside one function call. That's fundamentally incompatible with Inngest's durability model: from Inngest's perspective, that entire loop is one opaque unit. If it crashed on turn 6, Inngest could only retry the _whole_ call from turn 1 — directly violating the point of moving to Inngest at all.

The fix: the AI SDK's internal loop was abandoned entirely. `research-agent.ts` hand-rolls the ReAct loop itself, in a plain `while` loop, where:

- Each model turn is `generateText` called with `tools` that have **no `execute` function** — this is what actually forces single-step behavior (confirmed against current AI SDK docs), not the `stopWhen: stepCountIs(1)` also set alongside it, which is a redundant safety net, not the real mechanism. A tool without `execute` returns the model's tool-call request _unexecuted_; the loop naturally terminates after that one step regardless of `stopWhen`.
- Each individual tool call (search, save) is manually dispatched by the orchestrator's own code into its own `step.run()`.
- Tool-result messages are hand-built and appended to the message array in the exact shape (`{ role: "tool", content: [{ type: "tool-result", toolCallId, toolName, output }] }`) the AI SDK requires to keep the conversation valid on the next turn.

**What this preserves**: full model autonomy. The model still decides, turn by turn, whether to search again, save a finding, summarize, or call `done` — nothing about the decision logic is hardcoded. Only the _execution_ of each decision is now durable and independently retryable.

**What this costs**: the orchestrator now owns bookkeeping the AI SDK used to handle invisibly — reconstructing `messages` after every turn, tracking a separate turn counter (`stepCount`) independent of Inngest's own internal step count (Inngest's dashboard shows roughly 2x the turn count once tool calls are involved, since each turn now produces at least two `step.run()` calls), and manually keeping the tool-result/tool-call message pairing valid. Getting this pairing wrong is not cosmetic — it's a hard AI SDK validation error (see "Bugs found" below).

### Idempotent tool execution

Any `step.run()` can be retried by Inngest after a crash, re-running its callback from scratch. `insertNote()` (`lib/tools/save-note.ts`) is an upsert keyed on a `noteId` — but the ID itself is generated in its **own**, separately-memoized `step.run()`, called _before_ the insert step. This is the actual mechanism that makes retries safe: a retried insert step reuses the exact same `noteId` from the earlier, already-completed ID-generation step, so it upserts onto the same row instead of minting a new one.

**Verified, not assumed**: a synthetic post-insert failure was forced on the first `saveNote` call of a real run (the real Supabase write succeeds, then a debug throw fires, Inngest retries the step, the retry reuses the memoized `noteId` and upserts onto the same row). Confirmed via direct query: exactly one row for that note, not two.

### Retryable vs. non-retryable tool failures — a decision reversed after real testing

Both `webSearch` and `saveNote` classify their own failures (`classifyTavilyError`, `classifySupabaseError`): auth/config-class errors (401/403/400, permission/constraint violations) are `not-retryable`; connection/timeout/5xx-class errors are `retryable`.

The original design (Phase 3) threw a `NonRetriableError` for the not-retryable case, so Inngest's dashboard would show a distinct "non-retriable" marker and skip its retry loop entirely. **This was reversed during Phase 7 testing**, after tracing through what actually happens: throwing `NonRetriableError` from inside a `step.run()` propagates out of the surrounding loop's `await` — which had no local catch — crashing the _entire function_ before the model ever sees the failure as a tool result. Two real consequences of that, both discovered by testing rather than assumed:

1. `research_runs.status` never got updated past whatever it last was (usually `'running'`) — the run looked stuck forever from the frontend's perspective, not failed.
2. The system prompt's own instruction — _"if [webSearch] indicates an authorization... problem, call done immediately and report the tool failure"_ — became dead code. The model can't follow an instruction about a tool result it never receives.

**Current behavior**: not-retryable classifications are **returned** as a normal `{ success: false, error }` step result, not thrown. This achieves the same "zero wasted retries" outcome (nothing throws, so Inngest's retry loop never triggers) while letting the model actually see the failure and respond per its own instructions — restoring the graceful-degradation behavior Weeks 7–8 already verified and this project had implicitly assumed still worked. Trade-off, stated plainly: the Inngest dashboard now shows this case as a plain ✅ successful step containing a failure payload, not a distinct ❌ `NonRetriableError` marker — a deliberate choice, reversing a result that had already been verified passing once under the old design.

A top-level `try/catch` around the entire function body was added as a separate, remaining safety net — for genuinely unexpected failures (a bug, Supabase fully unreachable in an unclassified way) that still throw. It persists `status: 'failed'` with a warning before re-throwing, so Inngest's own function-level failure signal is preserved _and_ the app-facing status is never left stale.

### Replay-correctness bugs found and fixed

Two real determinism bugs were caught and fixed before this was trusted:

1. **Mutating closures inside a `step.run()` callback.** `hasSearched`/`hasSavedNote` were originally set to `true` _inside_ the tool-dispatch step's callback. On replay, Inngest skips re-invoking the callback for any already-completed step — it returns the memoized result directly. That means a mutation placed inside the callback silently fails to reapply after a crash-and-replay, even though the underlying tool call genuinely succeeded before the crash. Fixed by deriving these flags in the surrounding loop body (which does re-execute deterministically every replay) from the step's _returned_ value, never from a side effect inside the callback itself.
2. **Message-ordering bug in the human-in-loop `add-context` path.** The checkpoint gate originally ran _before_ the current turn's tool-result message was appended to `messages`. On the `add-context` resume path, this wedged a new `user` message between an assistant's tool-call and its corresponding tool-result — producing a real `AI_MissingToolResultsError` on the next model turn. Fixed by moving the tool-result append to happen strictly before the gate check, so a tool-call is always immediately followed by its result with nothing injected in between.

### Human-in-the-loop checkpoint

Once `hasSearched && hasSavedNote` are both true (and only once — guarded by a `hasPaused` flag so a later turn re-satisfying the same condition can't re-trigger it), the function marks `research_runs.status = 'awaiting_human_input'` and calls `step.waitForEvent("wait-for-human-input", { event: "research/human-input", match: "data.runId", timeout: "10m" })`. This is a genuinely durable wait — the local dev process can be killed entirely while a run is paused here, and it resumes correctly once restarted and the event arrives, because the wait itself is checkpointed by Inngest, not held open in server memory.

Two outcomes:

- **Event received** (`continue` or `add-context`): status flips back to `'running'`; `add-context` injects the extra text as a new `user` message before the loop resumes.
- **Timeout (10 minutes, no event)**: status → `'abandoned'`, a warning is recorded noting partial findings may exist in `research_notes`, and the function returns immediately — deliberately, no guessed continuation on the user's behalf.

### Status persistence

`research_runs` (schema below) is the authoritative, externally-queryable state — not Inngest's own internal execution state, which the frontend/API never touch directly. Status transitions: `pending` (set by the trigger route) → `running` (function start) → `awaiting_human_input` (checkpoint) → `running` (resumed) → terminal (`done` / `failed` / `abandoned`). `step_count` is persisted after every turn, not just at the end, so a crash mid-run shows real progress rather than stale data.

```sql
create table research_runs (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'awaiting_human_input', 'summarizing', 'done', 'failed', 'abandoned')),
  final_summary text,
  terminated_by_done boolean,
  step_count integer not null default 0,
  warning text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table research_notes (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references research_runs(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);
```

This schema was created fresh in Phase 1 — the old `research_notes.session_id`-keyed table and its Week 7/8 test data were dropped entirely rather than migrated, since none of it was real user data worth preserving.

## API routes — contract break from Week 8

The old `/api/research` was fully synchronous: one `POST`, one response, containing the final summary. That's gone.

- **`POST /api/research`** — creates a `research_runs` row (`status: 'pending'`), sends `research/requested`, returns `{ runId }` with **HTTP 202**, immediately. No summary. The caller must poll the status route to observe progress and retrieve the result. If the Inngest send itself fails, the run row is marked `'failed'` rather than left in a state nothing will ever process.
- **`GET /api/research/[runId]`** — reads current status from `research_runs`. Rejects non-UUID-shaped or nonexistent IDs with a clean `404` (checked before hitting Postgres, since an invalid UUID literal thrown at a `uuid` column produces a type error, not a clean "no rows").
- **`POST /api/research/[runId]/resume`** — validates `decision` is exactly `"continue"` or `"add-context"` (`400` otherwise), requires non-empty `extraContext` when `decision` is `"add-context"` (`400` otherwise — closes a gap where the agent function would have silently treated an empty add-context as a plain continue), and checks the run is actually `awaiting_human_input` before sending the event (`409` otherwise) — a resume signal for a run with no live `waitForEvent` would otherwise just vanish unacknowledged.

## Frontend

`/` — topic form, redirects to `/runs/[runId]` on submit.
`/runs/[runId]` — polls the status route every 2s (plain interval polling; SSE/websockets were explicitly out of scope for this exercise's scale). Renders a vertical stage timeline (Queued → Working → Checkpoint → Done), the Continue/Add-context controls (disabled on submission to prevent double-fire) during `awaiting_human_input`, a live countdown to the 10-minute checkpoint timeout, and distinct, plainly-worded panels for `done`, `failed`, and `abandoned` — `abandoned` is treated as a real, expected outcome state, not an error.

**No auth, no session management.** The `runId` in the URL is the only access control — same unguessable-server-generated-UUID pattern used throughout this project. Anyone with the link can view status and resume the run. Acceptable for this exercise's scope; not a substitute for real authorization before any multi-user deployment.

## What was removed, and why

Replacing the synchronous route made several things genuinely dead, not just unused:

- `webSearchTool`, `saveNoteTool`, `summarizeNotesTool`, `doneTool` (the AI-SDK `tool()` wrappers with `execute`) — no caller left once `route.ts` was replaced. Their core logic wasn't discarded: `insertNote()`, `callTavily()`, and `summarizeAllNotes()` were extracted as plain functions and are what the new architecture actually uses (or, for `summarizeAllNotes`, will use — see below).
- `lib/retry.ts` and its two test scripts — Inngest now owns all step-level retry/backoff; a second custom retry layer stacked underneath would double-wrap the same failures.
- `scripts/test-tools.ts`, `scripts/test-agent-step1.ts` — tested the deleted wrappers and the old AI-SDK-internal-loop pattern respectively; both are gone.

## What is carried over but not yet wired in — a real, open gap

`summarizeNotes` is **still a stub** in the live agent loop. The pure `summarizeAllNotes()` function (notes retrieval + the Week 8 `generateWithFallback` primary/fallback model call) was extracted intact during cleanup, but `research-agent.ts` does not call it — any run where the model invokes `summarizeNotes` gets back `{ success: false, error: "summarizeNotes not yet wired in this increment." }`. Decoupling this into its own step boundaries (DB read as one step, the nested LLM call as another, same idempotency/replay discipline as the rest of the loop) was deliberately deferred and never picked back up. Notably, Phase 7's 100% done-compliance measurement (below) was achieved with this tool permanently broken across all 20 runs — the model consistently worked around a non-functional tool rather than getting stuck on it, which is a positive resilience signal, but the tool itself remains unfinished.

## Observability and cost tracking — real regressions from Week 8, not addressed

- **No fallback model in the main agent loop.** `generateWithFallback` (primary `gemini-3.1-flash-lite`, fallback `gemini-3.5-flash`) still exists in `lib/models/`, but the only caller is the still-stubbed `summarizeAllNotes()` — not the main per-turn `generateText` call in `research-agent.ts`. A primary-model outage on the actual decision-making calls has no cross-model fallback at all; it would only get Inngest's own step retry (multiple attempts against the same model, then permanent failure). This is a meaningful regression from Week 8's fallback story, not carried forward, and not yet fixed.
- **No cost tracking of any kind.** Week 8's `costNote` field, pointing to Langfuse's per-session cost aggregation, has no equivalent here. The new status route has nothing comparable.
- **Langfuse's automatic AI-SDK tracing was never re-verified against this architecture.** `instrumentation.ts`'s global `registerTelemetry` hook is still in place and _may_ still automatically capture `generateText` calls made from inside `research-agent.ts`'s `step.run()` callbacks — but this was never explicitly tested. Inngest's execution model (steps replayed, potentially re-invoked, function bodies re-run from the top on retry) interacts with OpenTelemetry span lifecycles in ways this project has not checked. Treat Langfuse visibility for this pipeline as **unverified**, not confirmed working. Inngest's own dashboard is, in practice, the only observability tool actually exercised and trusted for this architecture.

## Phase 7 — measured results, not projections

**Item 1 — auth-class webSearch failure.** Forced via an invalid `TAVILY_API_KEY`. Confirmed: the step returns a single failed attempt (no wasted retries), the run reaches `status: 'done'` with `terminatedByDone: true`, and the model's own final summary correctly states the search failed and labels its content per the source-labeling rule — the exact graceful-degradation behavior the `NonRetriableError` reversal above was meant to restore, verified working after the fix.

**Item 2 — Tavily timeout, forced via a 1ms `AbortSignal.timeout`.** Real exponential backoff observed in the Inngest dashboard; total step duration ~5m23s before exhaustion. Retries were genuinely attempted with growing delays, not a single immediate failure. Exact attempt count was not recorded during testing and cannot be reconstructed after the fact — a real, if minor, gap in this measurement. Inngest's own documentation disagrees with itself on the default (3 vs. 4 retries), so this project has no independently-confirmed number either from testing or from a trustworthy doc source; treat the default retry count as unverified rather than assume either published figure. Upon exhaustion, the top-level `try/catch` correctly persisted `status: 'failed'` with a descriptive warning — confirmed directly via the status route, not assumed from the Inngest trace alone.

**Item 3 — done-compliance, N=20, full lifecycle including the checkpoint.** A new script (`scripts/measure-done-compliance-v2.ts`) drives each run through trigger → poll → auto-resume with `"continue"` at the checkpoint → poll to terminal, against the live server.

Terminated via done: 20/20 = 100.0%
Done without a done call (compliance gap, had text): 0/20
Failed (ceiling hit or no text at all): 0/20
Script-level timeout: 0/20

Stated with real scope, not as a blanket guarantee:

- Single fixed topic, single fixed resume decision (`"continue"` only — `add-context` was tested separately in Phase 4, not as part of this N=20 measurement).
- Sequential, not concurrent — no signal on behavior under parallel runs.
- Does not test compliance under a combination with the forced-failure paths from items 1–2 (e.g., a non-retryable tool failure occurring _after_ the checkpoint has already fired).

**Item 4 — source-labeling discipline.** Spot-checked across 5 `finalSummary` outputs from the item-3 batch. Labeling held in every case: specific figures from successful searches stated directly, general-knowledge asides isolated with their own `[Unverified...]` tag rather than folded into a blanket disclaimer. One run's model additionally, unprompted, flagged skepticism that its 2026 search results might reflect "a hypothetical or simulated future scenario" relative to its own training cutoff — correctly labeled per the letter of the current rule, but exposing a real gap the rule doesn't yet cover: the model voiced doubt about the plausibility of its retrieved data while still stating the specific figures from that same data with full, unhedged confidence. Not fixed here — flagged as a possible future refinement to the labeling instruction (a "call succeeded but is suspect" tier, distinct from "call succeeded" / "call failed"). Also not independently re-verified: whether `webSearch` genuinely returned `success: true` underlying all five inspected summaries — inferred from the presence of specific, unhedged figures, not confirmed against the raw Inngest step output for each one.

**Item 5 — abandon path, repeated for consistency.** Three total 10-minute abandon cycles run end-to-end across this project's testing (one in Phase 4, two more here): all three consistent — `status: 'abandoned'`, warning correctly populated noting partial findings may exist, frontend "Set aside" panel rendered correctly, no crash or hang in any of the three runs.

## Environment Variables

TAVILY_API_KEY
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
GOOGLE_GENERATIVE_AI_API_KEY
LANGFUSE_PUBLIC_KEY
LANGFUSE_SECRET_KEY
LANGFUSE_BASE_URL
INNGEST_DEV=1 # dev only — disables signature verification, never set in production

## Running

```bash
npm run dev
inngest dev   # or ./inngest dev if not on PATH — separate terminal, must stay running
```

Open `http://localhost:3000` for the frontend, or drive it directly:

```bash
curl -X POST http://localhost:3000/api/research \
  -H "Content-Type: application/json" \
  -d '{"topic": "your topic here"}'
# -> { "runId": "..." }

curl http://localhost:3000/api/research/<runId>
# poll until status is done/failed/abandoned

curl -X POST http://localhost:3000/api/research/<runId>/resume \
  -H "Content-Type: application/json" \
  -d '{"decision": "continue"}'
```

## Test Scripts

```bash
npx tsx scripts/test-fallback.ts               # generateWithFallback: synthetic 429/503/401/network cases — still valid, only consumer is the still-stubbed summarizeAllNotes()
npx tsx scripts/send-human-input.ts <runId> <continue|add-context> [extraContext]   # manually resume a paused run
npx tsx scripts/measure-done-compliance-v2.ts  # N real sequential full-lifecycle runs, tabulates done-compliance including the checkpoint
```

## What this is not

No auth or multi-tenant access control beyond the unguessable `runId` in the URL. No cost tracking of any kind. No cross-model fallback on the main agent loop's decision-making calls (only the still-unwired `summarizeNotes` path has fallback logic available to it). No re-verification that Langfuse's automatic tracing actually captures this architecture's LLM calls. `summarizeNotes` is a stub, not a working tool, in the live loop. `MAX_STEPS = 8` is unchanged from Week 8 and has not been re-measured against this architecture's different step-accounting (turn count vs. Inngest's own ~2x step count). Default Inngest retry count for transient tool failures was not recorded during testing. No test of failure modes under topic variety, the `add-context` resume path combined with the N=20 compliance measurement, or concurrent/parallel runs.
