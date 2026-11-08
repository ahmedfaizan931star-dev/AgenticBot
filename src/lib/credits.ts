import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export const COST = { llmRound: 1, search: 2, connector: 1, googleSearch: 3, mcp: 1, deepResearch: 10 } as const;

export class InsufficientCreditsError extends Error {
  constructor() {
    super("insufficient_credits");
  }
}

export async function getBalance(userId: string): Promise<number> {
  const { data, error } = await createAdminClient()
    .from("credits_balance")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.balance ?? 0;
}

export async function spend(userId: string, amount: number, reason: string, ref: string): Promise<number> {
  const { data, error } = await createAdminClient().rpc("spend_credits", {
    p_user: userId,
    p_amount: amount,
    p_reason: reason,
    p_ref: ref,
  });
  if (error) {
    if (error.message.includes("insufficient_credits")) throw new InsufficientCreditsError();
    throw error;
  }
  return data as number;
}

export async function refund(userId: string, ref: string): Promise<number | null> {
  const { data, error } = await createAdminClient().rpc("refund_credits", { p_user: userId, p_ref: ref });
  if (error) return null;
  return data as number;
}
