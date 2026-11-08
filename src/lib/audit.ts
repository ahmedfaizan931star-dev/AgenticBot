import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/** Append-only activity record shown to the user. Never throws: auditing must not break the action itself. */
export async function audit(userId: string, event: string, detail: Record<string, unknown> = {}) {
  try {
    await createAdminClient().from("audit_log").insert({ user_id: userId, event, detail });
  } catch {
    // ignore
  }
}
