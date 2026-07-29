"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

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
      // On success, buttons stay locked (resuming stays true) until polling
      // reflects the status change away from awaiting_human_input.
    } catch {
      setResumeError("Could not reach the server.");
      setResuming(false);
    }
  }

  if (notFound) {
    return (
      <main className="flex flex-1 items-center justify-center px-6">
        <div className="text-center">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">404</p>
          <h1 className="mt-3 font-display text-2xl font-medium text-text">No run at this address.</h1>
          <p className="mt-2 text-sm text-muted">Check the link, or start a new run from the home page.</p>
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

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
      <div className="mb-8">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">Run {run.runId.slice(0, 8)}</p>
        <h1 className="mt-2 font-display text-2xl font-medium text-text sm:text-3xl">{run.topic}</h1>
      </div>

      <div className="grid gap-8 sm:grid-cols-[180px_1fr]">
        <ol className="relative flex flex-row gap-4 sm:flex-col sm:gap-0">
          {STAGES.map((label, i) => {
            const isPast = i < idx;
            const isCurrent = i === idx;
            const isFinalStage = i === STAGES.length - 1;
            const dotColor = isFinalStage && isCurrent ? finalDotColor(run.status) : isPast || isCurrent ? "bg-signal" : "bg-border";

            return (
              <li key={label} className="relative flex flex-1 flex-col items-center gap-2 sm:flex-row sm:items-start sm:gap-3 sm:pb-8 last:pb-0">
                {!isFinalStage && <span aria-hidden className={`absolute left-1/2 top-2.5 hidden h-0.5 w-full sm:left-1.5 sm:top-3 sm:block sm:h-full sm:w-0.5 ${isPast ? "bg-signal" : "bg-border"}`} />}
                <span className={`relative z-10 h-3 w-3 shrink-0 rounded-full ${dotColor} ${isCurrent && !isFinalStage ? "animate-[pulse-dot_1.6s_ease-in-out_infinite]" : ""}`} />
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

              {resumeError && <p className="mt-3 text-sm text-danger">{resumeError}</p>}

              <div className="mt-5 flex flex-col gap-3">
                <div className="flex flex-wrap gap-3">
                  <button onClick={() => sendResume("continue")} disabled={resuming} className="rounded-md bg-checkpoint px-4 py-2 font-display text-sm font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50">
                    Continue
                  </button>
                  <button onClick={() => setShowContextInput((v) => !v)} disabled={resuming} className="rounded-md border border-border px-4 py-2 font-display text-sm font-medium text-text transition-colors hover:border-checkpoint disabled:opacity-50">
                    Add context
                  </button>
                </div>

                {showContextInput && (
                  <div>
                    <textarea value={contextText} onChange={(e) => setContextText(e.target.value)} disabled={resuming} placeholder="e.g. focus specifically on housing costs, not overall CPI" rows={3} className="w-full rounded-md border border-border bg-ink px-3 py-2 font-mono text-sm text-text placeholder:text-muted focus:border-checkpoint focus:outline-none disabled:opacity-50" />
                    <button onClick={() => sendResume("add-context", contextText.trim())} disabled={resuming || !contextText.trim()} className="mt-2 rounded-md bg-checkpoint px-4 py-2 font-display text-sm font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50">
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
    </main>
  );
}
