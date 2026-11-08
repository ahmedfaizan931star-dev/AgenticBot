import { describe, expect, it } from "vitest";
import { pendingToolCalls, toLlmMessages, trimHistory, type Row } from "@/lib/agent/history";

const call = (id: string, name = "browser_list_tabs") => ({ id, type: "function" as const, function: { name, arguments: "{}" } });
const row = (r: Partial<Row> & { role: Row["role"] }): Row => ({ content: null, tool_calls: null, tool_call_id: null, tool_name: null, ...r });

describe("pendingToolCalls", () => {
  it("finds unanswered calls in the last assistant message", () => {
    const rows = [row({ role: "user", content: "hi" }), row({ role: "assistant", tool_calls: [call("a"), call("b")] }), row({ role: "tool", tool_call_id: "a", content: "ok" })];
    expect(pendingToolCalls(rows).map((c) => c.id)).toEqual(["b"]);
  });
  it("is empty when everything is answered or there are no calls", () => {
    expect(pendingToolCalls([row({ role: "user", content: "x" }), row({ role: "assistant", content: "y" })])).toEqual([]);
    expect(pendingToolCalls([row({ role: "assistant", tool_calls: [call("a")] }), row({ role: "tool", tool_call_id: "a" })])).toEqual([]);
  });
  it("ignores older assistant messages", () => {
    const rows = [row({ role: "assistant", tool_calls: [call("old")] }), row({ role: "user", content: "next" }), row({ role: "assistant", content: "done" })];
    expect(pendingToolCalls(rows)).toEqual([]);
  });
});

describe("trimHistory", () => {
  it("never starts mid tool exchange", () => {
    const rows: Row[] = [row({ role: "user", content: "1" }), row({ role: "assistant", tool_calls: [call("a")] }), row({ role: "tool", tool_call_id: "a" }), row({ role: "assistant", content: "ok" }), row({ role: "user", content: "2" })];
    const out = trimHistory(rows, 3);
    expect(out[0]!.role).toBe("user");
    expect(out.map((r) => r.content)).toEqual(["2"]);
  });
  it("keeps short histories intact", () => expect(trimHistory([row({ role: "user", content: "a" })])).toHaveLength(1));
});

describe("toLlmMessages", () => {
  it("maps rows to chat messages", () => {
    const msgs = toLlmMessages([row({ role: "user", content: "hi" }), row({ role: "assistant", tool_calls: [call("a")] }), row({ role: "tool", tool_call_id: "a", content: "[]" })]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(msgs[1]).toMatchObject({ tool_calls: [{ id: "a" }] });
  });
});
