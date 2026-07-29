// lib/supabase/research-runs.ts
import { createSupabaseAdminClient } from "./admin-client";

export type RunStatus = "pending" | "running" | "awaiting_human_input" | "summarizing" | "done" | "failed" | "abandoned";

export interface ResearchRun {
  id: string;
  topic: string;
  status: RunStatus;
  final_summary: string | null;
  terminated_by_done: boolean | null;
  step_count: number;
  warning: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunUpdateFields {
  status?: RunStatus;
  final_summary?: string | null;
  terminated_by_done?: boolean;
  step_count?: number;
  warning?: string | null;
}

export async function updateRunStatus(runId: string, fields: RunUpdateFields) {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("research_runs")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", runId);

  if (error) {
    throw new Error(`Failed to update research_runs (${runId}): ${error.message}`);
  }
}

export async function createRun(topic: string): Promise<ResearchRun> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from("research_runs").insert({ topic, status: "pending" }).select("*").single();

  if (error || !data) {
    throw new Error(`Failed to create research_runs row: ${error?.message ?? "no row returned"}`);
  }
  return data;
}

export async function getRunById(runId: string): Promise<ResearchRun | null> {
  const supabase = createSupabaseAdminClient();
  // maybeSingle(), not single() — returns null for zero rows instead of
  // throwing, so a not-found run can be handled as a normal case rather
  // than an exception.
  const { data, error } = await supabase.from("research_runs").select("*").eq("id", runId).maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch research_runs (${runId}): ${error.message}`);
  }
  return data;
}
