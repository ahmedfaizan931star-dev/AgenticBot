import "server-only";
import type { ToolCall } from "@/lib/llm/types";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Row } from "./history";

export type NewRow = {
  role: Row["role"];
  content?: string | null;
  tool_calls?: ToolCall[] | null;
  tool_call_id?: string;
  tool_name?: string;
  is_error?: boolean;
  meta?: Record<string, unknown> | null;
};

export async function persistMessage(chatId: string, userId: string, row: NewRow) {
  const { error } = await createAdminClient().from("messages").insert({
    chat_id: chatId,
    user_id: userId,
    role: row.role,
    content: row.content ?? null,
    tool_calls: row.tool_calls ?? null,
    tool_call_id: row.tool_call_id ?? null,
    tool_name: row.tool_name ?? null,
    is_error: row.is_error ?? false,
    meta: row.meta ?? null,
  });
  if (error) throw error;
}

export async function loadRows(chatId: string, userId: string): Promise<Row[]> {
  const { data } = await createAdminClient()
    .from("messages")
    .select("role, content, tool_calls, tool_call_id, tool_name")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .order("seq", { ascending: false })
    .limit(200);
  return ((data ?? []) as Row[]).reverse();
}

/** Returns the chat id if it belongs to the user, otherwise null. */
export async function ownedChat(chatId: string, userId: string): Promise<string | null> {
  const { data } = await createAdminClient().from("chats").select("id").eq("id", chatId).eq("user_id", userId).maybeSingle();
  return data?.id ?? null;
}

export async function createChat(userId: string, firstMessage: string): Promise<string | null> {
  const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
  const { data } = await createAdminClient().from("chats").insert({ user_id: userId, title }).select("id").single();
  return data?.id ?? null;
}

export async function touchChat(chatId: string, userId: string) {
  await createAdminClient().from("chats").update({ updated_at: new Date().toISOString() }).eq("id", chatId).eq("user_id", userId);
}
