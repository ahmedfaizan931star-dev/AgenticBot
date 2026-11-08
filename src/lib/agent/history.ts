import type { ChatMessage, ToolCall } from "@/lib/llm/types";

export type Row = {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
  tool_name: string | null;
};

/** Tool calls in the latest assistant message that still have no stored result. */
export function pendingToolCalls(rows: Row[]): ToolCall[] {
  let lastAssistant = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant === -1) return [];
  const calls = rows[lastAssistant]!.tool_calls ?? [];
  if (calls.length === 0) return [];
  const answered = new Set(
    rows.slice(lastAssistant + 1).filter((r) => r.role === "tool" && r.tool_call_id).map((r) => r.tool_call_id!),
  );
  return calls.filter((c) => !answered.has(c.id));
}

/** Keeps the most recent rows, never starting in the middle of a tool exchange. */
export function trimHistory(rows: Row[], max = 60): Row[] {
  let out = rows.length > max ? rows.slice(rows.length - max) : rows;
  const firstUser = out.findIndex((r) => r.role === "user");
  if (firstUser > 0) out = out.slice(firstUser);
  return out;
}

export function toLlmMessages(rows: Row[]): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (const r of rows) {
    if (r.role === "user") msgs.push({ role: "user", content: r.content ?? "" });
    else if (r.role === "assistant") {
      msgs.push(
        r.tool_calls && r.tool_calls.length > 0
          ? { role: "assistant", content: r.content, tool_calls: r.tool_calls }
          : { role: "assistant", content: r.content ?? "" },
      );
    } else if (r.role === "tool" && r.tool_call_id) {
      msgs.push({ role: "tool", tool_call_id: r.tool_call_id, content: r.content ?? "" });
    }
  }
  return msgs;
}
