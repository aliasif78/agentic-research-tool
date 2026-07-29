"use client";

import { useState, type SubmitEvent } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    const trimmed = topic.trim();
    if (!trimmed) {
      setError("Enter a topic to research.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: trimmed }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to start the run.");
        setSubmitting(false);
        return;
      }

      const { runId } = await res.json();
      router.push(`/runs/${runId}`);
    } catch {
      setError("Could not reach the server. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-lg">
        <div className="mb-10">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">Research Agent</p>
          <h1 className="mt-3 font-display text-3xl font-medium tracking-tight text-text sm:text-4xl">Start a durable run.</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">The agent searches, saves findings, and pauses once to check in with you before it finishes. Close this tab any time — the run keeps going without you.</p>
        </div>

        <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-surface p-6">
          <label htmlFor="topic" className="font-mono text-xs uppercase tracking-[0.15em] text-muted">
            Topic
          </label>
          <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-ink px-3 py-2.5 focus-within:border-checkpoint">
            <span className="font-mono text-checkpoint">›</span>
            <input id="topic" type="text" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. current US inflation rate" disabled={submitting} className="flex-1 bg-transparent font-mono text-sm text-text placeholder:text-muted focus:outline-none disabled:opacity-50" />
          </div>

          {error && <p className="mt-3 text-sm text-danger">{error}</p>}

          <button type="submit" disabled={submitting} className="mt-5 w-full rounded-md bg-signal px-4 py-2.5 font-display text-sm font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50">
            {submitting ? "Starting…" : "Start run"}
          </button>
        </form>
      </div>
    </main>
  );
}
