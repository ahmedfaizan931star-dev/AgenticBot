import "server-only";
import { createClient } from "@supabase/supabase-js";
import { requirePublicEnv } from "@/lib/env";
import type { Database } from "./types";

let cached: ReturnType<typeof createClient<Database>> | null = null;

/** Service-role client. Bypasses RLS: only use after verifying the user and always scope by user id. */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  if (!cached) {
    cached = createClient<Database>(requirePublicEnv().supabaseUrl, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}
