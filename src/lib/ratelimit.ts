import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/** Fixed-window limiter backed by Postgres. Fails closed if the database check errors. */
export async function allow(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("rate_limit_hit", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) return false;
  return data === true;
}
