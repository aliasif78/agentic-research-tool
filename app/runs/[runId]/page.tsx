"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

type RunStatus = "pending" | "running" | "awaiting_human_input" | "summarizing" | "done" | "failed" | "abandoned";

interface RunStatusResponse {
  runId: string;
  topic: string;
  status: RunStatus;
  stepCount: number;
  terminatedByDone: boolean | null;
  finalSummary: string | null;
  warning: string | null;
  createdAt: string;
  updatedAt: string;
}

const STAGES = ["Queued", "Working", "Checkpoint", "Done"] as const;
const CHECKPOINT_TIMEOUT_SECONDS = 10 * 60;

function stageIndex(status: RunStatus): number {
  switch (status) {
    case "pending":
      return 0;
    case "running":
    case "summarizing":
      return 1;
    case "awaiting_human_input":
      return 2;
    default:
      return 3; // done, failed, abandoned
  }
}

function finalDotColor(status: RunStatus): string {
  if (status === "done") return "bg-success";
  if (status === "failed") return "bg-danger";
  if (status === "abandoned") return "bg-muted";
  return "bg-border";
}

function finalGlowColor(status: RunStatus): string {
  if (status === "done") return "var(--color-success)";
  if (status === "failed") return "var(--color-danger)";
  return "var(--color-muted)";
}

function formatCountdown(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function RunStatusPage() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId;

  const [run, setRun] = useState<RunStatusResponse | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [showContextInput, setShowContextInput] = useState(false);
  const [contextText, setContextText] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/research/${runId}`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          clearInterval(intervalId);
          return;
        }
        const data: RunStatusResponse = await res.json();
        if (cancelled) return;
        setRun(data);
        if (["done", "failed", "abandoned"].includes(data.status)) {
          clearInterval(intervalId);
        }
      } catch {
        // transient fetch failure — the next interval tick retries
      }
    }

    const intervalId = setInterval(poll, 2000);
    poll();

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [runId]);

  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  // The only setState call here lives inside the interval callback — a
  // genuine subscription to an external system (the passage of time), which
  // is exactly what effects are for. No setState runs synchronously in the
  // effect body itself, and no impure Date.now() call happens during render;
  // remainingSeconds is now a plain, already-computed number by the time
  // render reads it. Trade-off, stated plainly: the countdown text doesn't
  // appear until the first tick fires, ~1s after the checkpoint begins,
  // rather than instantly — accepted rather than reintroducing a
  // synchronous setState to avoid it.
  useEffect(() => {
    if (run?.status !== "awaiting_human_input") return;

    const deadline = new Date(run.updatedAt).getTime() + CHECKPOINT_TIMEOUT_SECONDS * 1000;

    const id = setInterval(() => {
      setRemainingSeconds(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    }, 1000);

    return () => clearInterval(id);
  }, [run?.status, run?.updatedAt]);

  async function sendResume(decision: "continue" | "add-context", extraContext?: string) {
    setResuming(true);
    setResumeError(null);
    try {
      const res = await fetch(`/api/research/${runId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, ...(extraContext ? { extraContext } : {}) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setResumeError(body.error ?? "Failed to resume the run.");
        setResuming(false);
      }
    } catch {
      setResumeError("Could not reach the server.");
      setResuming(false);
    }
  }

  if (notFound) {
    return (
      <main className="flex flex-1 items-center justify-center px-6">
        <div className="animate-[fade-slide-up_0.5s_ease-out] text-center">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">404</p>
          <h1 className="mt-3 font-display text-2xl font-medium text-text">No run at this address.</h1>
          <p className="mt-2 text-sm text-muted">Check the link, or start a new run.</p>
          <Link href="/" className="mt-5 inline-block cursor-pointer rounded-md border border-border px-4 py-2 font-display text-sm font-medium text-text transition-colors hover:border-signal">
            Start a new run
          </Link>
        </div>
      </main>
    );
  }

  if (!run) {
    return (
      <main className="flex flex-1 items-center justify-center px-6">
        <p className="font-mono text-sm text-muted">Loading run…</p>
      </main>
    );
  }

  const idx = stageIndex(run.status);
  const isTerminal = ["done", "failed", "abandoned"].includes(run.status);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
      <div className="mb-8 animate-[fade-slide-up_0.5s_ease-out]">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">Run {run.runId.slice(0, 8)}</p>
        <h1 className="gradient-text mt-2 font-display text-2xl font-medium sm:text-3xl">{run.topic}</h1>
      </div>

      <div className="grid animate-[fade-slide-up_0.6s_ease-out] gap-8 sm:grid-cols-[180px_1fr]">
        <ol className="relative flex flex-row gap-4 sm:flex-col sm:gap-0">
          {STAGES.map((label, i) => {
            const isPast = i < idx;
            const isCurrent = i === idx;
            const isFinalStage = i === STAGES.length - 1;
            const dotColor = isFinalStage && isCurrent ? finalDotColor(run.status) : isPast || isCurrent ? "bg-signal" : "bg-border";
            const glowColor = isFinalStage && isCurrent ? finalGlowColor(run.status) : "var(--color-signal)";

            return (
              <li key={label} className="relative flex flex-1 flex-col items-center gap-2 sm:flex-row sm:items-start sm:gap-3 sm:pb-8 last:pb-0">
                {!isFinalStage && <span aria-hidden className={`absolute left-1/2 top-2.5 hidden h-0.5 w-full sm:left-1.5 sm:top-3 sm:block sm:h-full sm:w-0.5 ${isPast ? "bg-signal" : "bg-border"}`} />}
                <span className={`relative z-10 h-3 w-3 shrink-0 rounded-full ${dotColor} ${isCurrent && !isFinalStage ? "animate-[pulse-dot_1.6s_ease-in-out_infinite]" : ""}`} style={isCurrent ? { boxShadow: `0 0 10px ${glowColor}` } : undefined} />
                <span className={`font-mono text-xs uppercase tracking-wide sm:pt-0.5 ${isCurrent ? "text-text" : "text-muted"}`}>{label}</span>
              </li>
            );
          })}
        </ol>

        <div className="rounded-lg border border-border bg-surface p-6">
          {(run.status === "pending" || run.status === "running" || run.status === "summarizing") && (
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.15em] text-signal">{run.status}</p>
              <p className="mt-3 text-sm leading-relaxed text-muted">The agent is working — searching, saving findings, and deciding its next move on its own.</p>
              <p className="mt-4 font-mono text-xs text-muted">Turns so far: {run.stepCount}</p>
            </div>
          )}

          {run.status === "awaiting_human_input" && (
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.15em] text-checkpoint">Your turn</p>
              <p className="mt-3 text-sm leading-relaxed text-text">The agent has searched and saved its first findings. Continue as-is, or steer it with more context.</p>

              {remainingSeconds !== null && <p className="mt-2 font-mono text-xs text-muted">{remainingSeconds > 0 ? `Set aside automatically in ${formatCountdown(remainingSeconds)} if no response arrives.` : "Wait window elapsed — waiting for the run to update."}</p>}

              {resumeError && <p className="mt-3 text-sm text-danger">{resumeError}</p>}

              <div className="mt-5 flex flex-col gap-3">
                <div className="flex flex-wrap gap-3">
                  <button onClick={() => sendResume("continue")} disabled={resuming} className="cursor-pointer rounded-md bg-checkpoint px-4 py-2 font-display text-sm font-medium text-ink transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50">
                    Continue
                  </button>
                  <button onClick={() => setShowContextInput((v) => !v)} disabled={resuming} className="cursor-pointer rounded-md border border-border px-4 py-2 font-display text-sm font-medium text-text transition-all hover:border-checkpoint active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50">
                    Add context
                  </button>
                </div>

                {showContextInput && (
                  <div>
                    <textarea value={contextText} onChange={(e) => setContextText(e.target.value)} disabled={resuming} placeholder="e.g. focus specifically on housing costs, not overall CPI" rows={3} className="w-full rounded-md border border-border bg-ink px-3 py-2 font-mono text-sm text-text placeholder:text-muted focus:border-checkpoint focus:outline-none disabled:opacity-50" />
                    <button onClick={() => sendResume("add-context", contextText.trim())} disabled={resuming || !contextText.trim()} className="mt-2 cursor-pointer rounded-md bg-checkpoint px-4 py-2 font-display text-sm font-medium text-ink transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50">
                      Send and continue
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {run.status === "done" && (
            <div>
              <div className="flex items-center gap-2">
                <p className="font-mono text-xs uppercase tracking-[0.15em] text-success">Done</p>
                <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted">{run.terminatedByDone ? "via done" : "no done call"}</span>
              </div>
              {run.warning && <p className="mt-3 text-sm text-signal">{run.warning}</p>}
              <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-text">{run.finalSummary ?? "No summary was produced."}</p>
              <p className="mt-4 font-mono text-xs text-muted">Turns used: {run.stepCount}</p>
            </div>
          )}

          {run.status === "failed" && (
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.15em] text-danger">Failed</p>
              <p className="mt-3 text-sm leading-relaxed text-text">{run.warning ?? "The run did not complete."}</p>
              <p className="mt-4 font-mono text-xs text-muted">Turns used: {run.stepCount}</p>
            </div>
          )}

          {run.status === "abandoned" && (
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.15em] text-muted">Set aside</p>
              <p className="mt-3 text-sm leading-relaxed text-text">No response arrived within the wait window, so this run was set aside rather than guessed at.</p>
              {run.warning && <p className="mt-3 text-sm text-muted">{run.warning}</p>}
            </div>
          )}
        </div>
      </div>

      {isTerminal && (
        <div className="mt-8 animate-[fade-slide-up_0.7s_ease-out]">
          <Link href="/" className="inline-block cursor-pointer rounded-md border border-border px-4 py-2 font-display text-sm font-medium text-text transition-all hover:border-signal active:scale-[0.98]">
            Perform another search
          </Link>
        </div>
      )}
    </main>
  );
}
