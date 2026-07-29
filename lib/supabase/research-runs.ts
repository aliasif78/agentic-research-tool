// lib/supabase/research-runs.ts
import { createSupabaseAdminClient } from "./admin-client";

export type RunStatus = "pending" | "running" | "awaiting_human_input" | "summarizing" | "done" | "failed" | "abandoned";

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
