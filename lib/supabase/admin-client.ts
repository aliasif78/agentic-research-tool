// lib/supabase/admin-client.ts
import { createClient } from "@supabase/supabase-js";
import { getSupabaseKeys } from "./get-supabase-keys";

export function createSupabaseAdminClient() {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = getSupabaseKeys();
  return createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
}
