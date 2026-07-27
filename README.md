# Agentic Research Tool — Week 8 (Reliability and Observability)

A ReAct-style research agent: given a topic, it searches the web, saves findings, optionally condenses them, and produces a final grounded summary. Week 7 built the agent and stress-tested termination reliability. Week 8 adds retry-with-backoff, a model fallback chain, full Langfuse tracing, verified cost tracking, and re-measures the failure modes Week 7 could only assert by hand.

## Architecture

Single API route (`app/api/research/route.ts`), no frontend. `POST { topic: string }` runs a tool-calling loop via the Vercel AI SDK's `generateText` with four tools, wrapped in a primary/fallback model layer and end-to-end Langfuse tracing.

- **`webSearch`** — Tavily API. Wrapped in `lib/retry.ts`'s `withRetry`: 3 attempts, exponential backoff with jitter, classifying 401/403/400 as non-retryable and 429/5xx/timeout/network errors as retryable. Every attempt (including the eventual success or exhaustion) is logged to a `webSearch-attempt-N` Langfuse span nested under a `webSearch-tool-call` span.
- **`saveNote`** — writes one finding at a time to `research_notes` in Supabase, scoped by a server-generated `sessionId`. Also wrapped in `withRetry`, classifying raw network `TypeError`s and Postgres SQLSTATE-08xxx (connection-class) errors as retryable, and constraint/permission/data errors as not — retrying a duplicate-key violation can't fix bad data, so it doesn't try.
- **`summarizeNotes`** — a nested `generateText` call that condenses saved notes, running through the same `generateWithFallback` primary/fallback layer as the main loop, with `maxRetries: 3` set explicitly (AI SDK's own built-in exponential backoff — see Retry Architecture below for why this call does NOT use `withRetry`).
- **`done`** — the model's explicit termination signal, unchanged from Week 7.

### Retry Architecture — two different mechanisms, used correctly, not redundantly

There are two distinct retry mechanisms in this codebase, and knowing which applies where matters:

1. **The Vercel AI SDK's own built-in `maxRetries`** (default: 2, set explicitly to 3 here) handles transient failures on `generateText`'s call to the model provider itself, using its own exponential backoff and classifying `APICallError` by status code. This covers the main agent loop's `generateText` call and `summarizeNotesTool`'s nested `generateText` call.
2. **This project's own `lib/retry.ts` (`withRetry`)** handles everything the AI SDK has no visibility into: the raw `fetch` to Tavily in `webSearch`, and the Supabase insert in `saveNote`. Neither is a model-provider call, so the AI SDK's retry logic never sees them.

Wrapping the AI SDK's own model calls in a second custom retry layer was deliberately avoided — it would stack two independent exponential-backoff mechanisms on the same call, compounding delays unpredictably and double-counting attempts once tracing is involved. The dividing line: **if the AI SDK is making the HTTP call to the LLM, it retries for you; anything called directly — search APIs, databases, any other third-party service — gets retried by this project's own `withRetry`.**

`withRetry` is verified against real invariants, not just the happy path:

- Retryable error → retries → succeeds: verified, all 3 attempts logged including the success.
- Retryable error, exhausts all attempts: verified, throws with a full `attemptLog` attached.
- Non-retryable error: verified, fails immediately, zero wasted retries.
- Real-world confirmation: a genuinely revoked Tavily key produced a real 401, correctly classified not-retryable, single attempt, no wasted delay.

See `scripts/test-retry.ts` and `scripts/test-save-note-retry.ts` for the test suites (synthetic errors only — a real transient 503/429 can't be forced on demand from either Tavily or Supabase, so these test `withRetry`'s classification and control flow directly rather than through the live third-party API).

### Fallback Chain

`lib/models/generate-with-fallback.ts` wraps both the main agent loop's model call and the nested `summarizeNotes` call in one shared helper: primary `gemini-3.1-flash-lite`, fallback `gemini-3.5-flash`.

**Fallback only triggers on errors classified retryable** (429/5xx/network/timeout) — **not** on 401/403/400. Both models share the same API key, so an auth or malformed-request error on the primary would fail identically on the fallback; attempting it anyway would just be a wasted round trip. This reuses the same retryable/not-retryable taxonomy as `withRetry`, applied to `APICallError`.

**Fallback model history, worth knowing:** the original fallback choice was `gemini-2.5-flash`. It passed every synthetic unit test (`scripts/test-fallback.ts`) and looked correct on paper. The first real forced-fallback test against the live API returned: _"This model models/gemini-2.5-flash is no longer available to new users."_ The model had been restricted to legacy accounts, invisibly to anything short of an actual call. This is the single clearest lesson from this phase of the project: **a model choice can pass every synthetic test and still be dead in production, and the only way to know is to actually call it for real.** Swapped to `gemini-3.5-flash`, re-verified with a real forced-fallback run that completed a full 6-step agent loop successfully, with cost independently confirmed by arithmetic against Google's published per-token rates (see Cost Tracking below).

**Known, documented limitation — fallback restarts the entire run, it does not resume mid-run.** `generateText` with `tools`/`stopWhen` runs an entire multi-step tool-calling loop inside one call; if the primary model fails on, say, step 4, `generateWithFallback` sees the failure only after the _whole_ call throws, and the fallback attempt starts the agent from scratch. Two real consequences:

- **Wasted cost**: any successful steps before the failure are paid for and discarded.
- **Duplicate notes**: `sessionId` is generated once, before the fallback layer is invoked, and both the primary and fallback attempts write to the same session — if the primary saved notes before failing, and the fallback re-runs the same searches, `research_notes` can end up with duplicates from both attempts.

Both are real, present, undocumented-until-now tradeoffs of this design, not bugs — accepted for the sake of not re-architecting mid-run state resumption in Week 8's scope.

**Correlated-failure limitation** — same-provider fallback protects against one model being flaky, rate-limited, or returning garbage. It does not protect against a Google-wide outage or an account/billing failure — both legs share the same API key and would fail together. Confirmed directly: forcing both primary and fallback to fail in one real request correctly propagated a combined error and a `502` — the failure-handling logic works — but the _scenario itself_ (both models down) is a real gap this architecture cannot close, only handle gracefully when it happens.

Verified with real, non-synthetic evidence:

- Single fallback trigger (429-class), real request, full 6-step agent run completed successfully on the fallback model, cost independently verified by arithmetic.
- Total double-failure (both models throwing), real request: correct `502`, correct `modelUsed: null`/`fallbackTriggered: true`, clean structured error log, no unhandled exception, Langfuse trace showed `fallbackSucceeded: false` with the real fallback error message, appeared promptly.

**Unverified, stated plainly rather than assumed:** the double-failure test above used a synthetic throw placed _before_ either model call, so it never exercised the AI SDK's own internal backoff timing on either model — a real double-failure, where both models genuinely exhaust their own retries slowly before failing, has different timing characteristics than what was tested. Also unverified: `flushLangfuse()`'s behavior under an actual serverless cold-shutdown (see Observability below) — this was only ever tested against `next dev` locally, which has no sandbox-freezing behavior to actually stress that code path.

### Observability (Langfuse)

Integrated via `instrumentation.ts` (Next.js's own startup hook, not a standalone script) using AI SDK 7's current integration path: `registerTelemetry(new LangfuseVercelAiSdkIntegration())` alongside a `NodeSDK` with `LangfuseSpanProcessor`. Requires Node.js 22+.

- **Automatic**: every `generateText` call — main loop, nested `summarizeNotes` — produces a `generation` observation with prompt, response, token usage, and cost, with zero code changes at the call site.
- **Manual**: `webSearch` and `saveNote` wrap their entire tool execution in `startActiveObservation` (auto-ending span covering the whole call), with each individual retry attempt logged as a nested `startObservation` child span via an `onAttempt` hook added to `withRetry` — kept optional and vendor-agnostic, so the retry primitive itself has no dependency on Langfuse. The fallback trigger gets its own `model-fallback-triggered` span in `generate-with-fallback.ts`, same pattern.
- **Session grouping**: `propagateAttributes({ sessionId }, ...)` wraps the entire route handler body, so every span produced anywhere in a request — automatic or manual, in any file — carries the same `sessionId`, letting the dashboard group an entire research run into one filterable view.
- **Explicit flush**: `forceFlush()` is called before every `NextResponse.json(...)` return, since Langfuse buffers spans asynchronously and a non-streaming serverless response has no guaranteed post-response execution window. Verified locally to not break anything; **not verified** against a real serverless cold-shutdown (see limitation above).

Verified with real evidence, not assumed: retry-attempt spans confirmed correctly nested under their parent tool-call span in a real trace; a forced multi-attempt case (one synthetic failure then a real success) showed exactly two child spans with correct classifications and delays; the entire trace tree — automatic model-call spans and manual tool/retry/fallback spans — nests correctly relative to each other because both share the same underlying OpenTelemetry context.

### Cost Tracking

The route's own hand-rolled `outerUsage` token counter was **removed**, not fixed a second time. It excluded the nested `summarizeNotes` call by construction (a documented Week 7 gap), and Langfuse already solves this correctly via its own span aggregation — reimplementing that in application code would be duplicate, worse machinery. The API response now includes a `costNote` field pointing to the authoritative total in Langfuse, keyed by `sessionId`, instead of a number that looked complete but wasn't.

**Verified correct by arithmetic, not assumed from the dashboard total:**

- `gemini-3.1-flash-lite`: Google's current published rate is $0.25/1M input, $1.50/1M output. A real traced run's exact token counts, run through that rate by hand, matched the Langfuse-reported cost to the fraction of a cent.
- `gemini-3.5-flash`: Google's current published rate is $1.50/1M input, $9.00/1M output. Same manual check against a real forced-fallback trace, confirmed exact match, per generation, across all 6 steps of that run.

This matters beyond "the math checks out": Langfuse's cost calculation depends on an exact string match between the model name and a pricing entry in its models table, and this exact model family (Gemini 2.5/3.x) has a documented history of _silently_ showing zero cost when no matching entry exists — no error, just a blank number. Both models in this project's actual fallback chain were checked against Google's own pricing page and confirmed to have correct, current, non-zero cost tracking in Langfuse. Do not assume a new or changed model's cost is being tracked correctly without doing this same check.

### Failure Modes — measured with real evidence, not asserted

Three failure modes were deliberately forced through the live server (not just synthetic unit tests) and observed via real console logs, real HTTP responses, and real Langfuse traces:

**1. Total `webSearch` outage (Tavily down for the entire run).**
Forced via a synthetic unconditional throw in `callTavily`. Result: all 3 retry attempts fired and were correctly classified retryable with real growing backoff delays; the model recognized the "503/service-availability" pattern named explicitly in its system prompt and did not waste further search attempts; termination via `done` was clean; the final summary correctly labeled every substantive sentence `[Unverified, from general knowledge, not from search]` per the system prompt's rule for total search failure, and — on the real production topic (US inflation), not just a throwaway test topic — chose to state plainly that no data could be retrieved rather than invent a plausible-sounding but fabricated number. Verified in both console output and the Langfuse trace (correct nested attempt spans, correct classifications).

**2. Total model failure (both primary and fallback genuinely erroring).**
Forced via a synthetic unconditional throw on both `PRIMARY_MODEL` and `FALLBACK_MODEL` branches inside `generateWithFallback`. Result: correct `502` HTTP response, correct combined error message naming both models' individual failures, correct `modelUsed: null`/`fallbackTriggered: true` metadata, clean structured console error log with no unhandled exception, and a Langfuse trace showing `fallbackSucceeded: false` with the real fallback error, appearing promptly. See the Fallback Chain section above for the two honestly-scoped caveats on what this test does and doesn't prove (backoff timing, serverless flush behavior).

**3. `done`-compliance under total search failure — re-measured, not re-asserted.**
The Week 7 README documented ~80% compliance from a manual N=10 test, hand-extracted from raw console logs before any of this infrastructure existed — exactly the "manual-aggregation problem Langfuse exists to solve," in that document's own words. Re-measured here with a real scripted N=20 (`scripts/measure-done-compliance.ts`, hitting the live server with real sequential requests, under the same total-search-failure condition, then tabulating `terminatedByDone` automatically instead of by hand): **20/20 = 100%**, zero hard failures.

This is real improvement, but is stated with its actual, honest scope, not oversold:

- Single fixed topic, run 20 times identically — not tested across topic variety.
- The forced failure signature (`"503"` in the error string) is close to verbatim what the system prompt's own error-recognition instruction names — this measures compliance against the easiest-to-recognize failure shape, not failure in general (an ambiguous partial result or a non-standard error shape is untested and likely harder).
- Source-labeling correctness was spot-checked on a handful of the 20 runs' console-logged summaries, not independently re-verified on all 20.

**The most defensible explanation for the improvement, and the reason no corrective-reprompt mechanism was built:** the retry layer added in this phase gives the tool a fully-formed, unambiguous `{success: false, error, attemptLog}` result after 3 real attempts, where previously a dead search API likely produced a single ambiguous failure signal. The most likely explanation is that **the retry layer removed the ambiguity that was probably causing the original compliance gap** — not that the model or prompt changed at all. Since the measured gap did not reproduce under the controlled re-test, building a speculative fix for a problem that isn't currently occurring was deliberately skipped in favor of documenting the measurement and its limits honestly.

## What this is not

Still no frontend — same reasoning as Week 7: raw JSON responses over `curl` surface failure states a chat UI would visually smooth over, and that visibility was the point of this phase's testing.

No multi-tenant auth — `sessionId` is server-generated per request so a client can't guess another session's ID, but there's no user-account layer restricting who can start a session at all (Week 9 / capstone territory).

No verification of `forceFlush()` under real serverless conditions — only tested against `next dev` locally, which has no sandbox-freezing behavior to actually stress the code path it was written for. A real Vercel deployment test is a named, open gap, not an assumed pass.

No test of failure modes under topic variety, ambiguous (non-503-shaped) failures, or concurrent/parallel requests — every measurement in this phase used a single fixed topic and sequential requests, deliberately, to isolate the variable being tested. Broader coverage is a reasonable next step, not something quietly assumed to generalize.

## Environment Variables

TAVILY_API_KEY
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
GOOGLE_GENERATIVE_AI_API_KEY
LANGFUSE_PUBLIC_KEY
LANGFUSE_SECRET_KEY
LANGFUSE_BASE_URL

## Running

```bash
npm run dev
curl -X POST http://localhost:3000/api/research \
  -H "Content-Type: application/json" \
  -d '{"topic": "your topic here"}'
```

## Test Suites

```bash
npx tsx scripts/test-retry.ts               # withRetry: synthetic retryable/non-retryable/exhaustion cases
npx tsx scripts/test-save-note-retry.ts     # Supabase-specific error classification, synthetic only
npx tsx scripts/test-fallback.ts            # generateWithFallback: synthetic 429/503/401/network cases
npx tsx scripts/test-tools.ts               # all four tools, real happy-path + real invalid-key check
npx tsx scripts/measure-done-compliance.ts  # N real sequential requests, tabulates done-compliance under forced total search failure (requires dev server running, and the synthetic outage temporarily added to web-search.ts — see git history / PR notes for exact placement)
```
