import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmEvent } from "@/lib/llm/types";
import { makeFakeDb } from "./fakeDb";

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof import("./fakeDb").makeFakeDb> | null,
  turns: [] as LlmEvent[][],
  toolSets: [] as string[][],
  status: {} as Record<string, { label: string | null; mode: "read" | "write" } | undefined>,
  githubWrite: vi.fn(),
  llmCalls: 0,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ratelimit", () => ({ allow: async () => true }));
vi.mock("@/lib/connectors/store", () => ({ connectionStatus: async () => h.status }));
vi.mock("@/lib/connectors/write", () => ({ githubWrite: h.githubWrite, driveWrite: vi.fn() }));
vi.mock("@/lib/credits", async (orig) => ({ ...(await orig<typeof import("@/lib/credits")>()), spend: vi.fn(async () => 100), refund: vi.fn(async () => 100) }));
vi.mock("@/lib/llm/provider", () => ({
  streamCompletion: async function* (opts: { tools: { function: { name: string } }[] }) {
    h.llmCalls++;
    h.toolSets.push(opts.tools.map((t) => t.function.name));
    const turn = h.turns.shift() ?? [{ type: "text", delta: "ok" }, { type: "done" }];
    for (const e of turn) yield e;
  },
}));

import { runAgent } from "@/lib/agent/run";
import type { StreamEvent } from "@/lib/agent/events";

const call = (id: string, name: string, args: unknown) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const turnWith = (...calls: ReturnType<typeof call>[]): LlmEvent[] => [{ type: "tool_calls", calls }, { type: "done" }];
const text = (t: string): LlmEvent[] => [{ type: "text", delta: t }, { type: "done" }];
const COMMIT = { repo: "o/r", path: "docs/a.md", content: "hello", message: "Add docs", branch: "agent/docs" };
const base = { mode: "chat" as const, extension: false };

async function run(input: Parameters<typeof runAgent>[1]) {
  const out: StreamEvent[] = [];
  for await (const e of runAgent("u1", input)) out.push(e);
  return out;
}
const types = (ev: StreamEvent[]) => ev.map((e) => e.type);

beforeEach(() => {
  h.db = makeFakeDb({ chats: [{ id: "c1", user_id: "u1", title: "t" }] });
  h.turns = [];
  h.toolSets = [];
  h.llmCalls = 0;
  h.status = { github: { label: "me", mode: "write" } };
  h.githubWrite.mockReset().mockResolvedValue({ ok: true, text: "done" });
});

describe("write actions in the agent loop", () => {
  it("turns a write tool call into a pending proposal, runs nothing, and stops to wait for the user", async () => {
    h.turns = [turnWith(call("t1", "github_commit_file", COMMIT))];
    const ev = await run({ kind: "user", chatId: "c1", content: "add docs", ...base });
    expect(types(ev)).toContain("approval_required");
    expect(types(ev).at(-1)).toBe("awaiting_approval");
    expect(h.githubWrite).not.toHaveBeenCalled();
    expect(h.llmCalls).toBe(1);
    expect(h.db!.tables.pending_actions).toHaveLength(1);
    expect(h.db!.tables.pending_actions![0]).toMatchObject({ status: "pending", tool: "github_commit_file", user_id: "u1" });
    const tool = h.db!.tables.messages!.find((m) => m.role === "tool")!;
    expect(String(tool.content)).toMatch(/NOT happened yet/);
  });

  it("refuses a proposal aimed at the default branch and lets the model carry on", async () => {
    h.turns = [turnWith(call("t1", "github_commit_file", { ...COMMIT, branch: "main" })), text("I could not do that.")];
    const ev = await run({ kind: "user", chatId: "c1", content: "push to main", ...base });
    expect(types(ev)).not.toContain("approval_required");
    expect(types(ev).at(-1)).toBe("done");
    expect(h.db!.tables.pending_actions).toHaveLength(0);
    expect(h.githubWrite).not.toHaveBeenCalled();
  });

  it("only offers write tools when the connector is in write mode", async () => {
    await run({ kind: "user", chatId: "c1", content: "hi", ...base });
    expect(h.toolSets[0]).toContain("github_commit_file");
    expect(h.toolSets[0]).toContain("github_open_pr");
    h.status = { github: { label: "me", mode: "read" } };
    await run({ kind: "user", chatId: "c1", content: "hi", ...base });
    expect(h.toolSets[1]).toContain("github_read_file");
    expect(h.toolSets[1]!.some((n) => ["github_commit_file", "github_open_pr", "github_create_issue", "github_comment"].includes(n))).toBe(false);
    h.status = {};
    await run({ kind: "user", chatId: "c1", content: "hi", ...base });
    expect(h.toolSets[2]!.some((n) => n.startsWith("github_") || n.startsWith("drive_"))).toBe(false);
  });

  it("never offers merge, delete or Google search unless enabled", async () => {
    await run({ kind: "user", chatId: "c1", content: "hi", ...base });
    const all = h.toolSets[0]!;
    expect(all.some((n) => /merge|delete|force/.test(n))).toBe(false);
    expect(all).not.toContain("google_search");
  });

  it("continue is refused while an approval is still waiting", async () => {
    h.turns = [turnWith(call("t1", "github_commit_file", COMMIT))];
    await run({ kind: "user", chatId: "c1", content: "add docs", ...base });
    const before = h.llmCalls;
    const ev = await run({ kind: "continue", chatId: "c1", ...base });
    expect(ev.find((e) => e.type === "error")).toMatchObject({ code: "approval_pending" });
    expect(h.llmCalls).toBe(before);
  });

  it("a new user message expires the waiting proposal instead of leaving it live", async () => {
    h.turns = [turnWith(call("t1", "github_commit_file", COMMIT))];
    await run({ kind: "user", chatId: "c1", content: "add docs", ...base });
    await run({ kind: "user", chatId: "c1", content: "never mind", ...base });
    expect(h.db!.tables.pending_actions![0]!.status).toBe("expired");
    expect(h.githubWrite).not.toHaveBeenCalled();
  });

  it("other users cannot continue or write into someone else's chat", async () => {
    const out: StreamEvent[] = [];
    for await (const e of runAgent("intruder", { kind: "user", chatId: "c1", content: "hi", ...base })) out.push(e);
    expect(out[0]).toMatchObject({ type: "error", code: "not_found" });
    expect(h.llmCalls).toBe(0);
  });
});

describe("planning and parallel tools", () => {
  it("shows the plan to the user and answers every tool call in the same step", async () => {
    h.turns = [
      turnWith(call("p1", "update_plan", { steps: [{ text: "Look up notes", status: "doing" }, { text: "Answer", status: "todo" }] }), call("r1", "recall", {}), call("r2", "recall", {})),
      text("Done."),
    ];
    const ev = await run({ kind: "user", chatId: "c1", content: "plan it", ...base });
    expect(ev.find((e) => e.type === "plan")).toMatchObject({ steps: [{ text: "Look up notes", status: "doing" }, { text: "Answer", status: "todo" }] });
    const answered = h.db!.tables.messages!.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(answered.sort()).toEqual(["p1", "r1", "r2"]);
    expect(types(ev).at(-1)).toBe("done");
    expect(h.llmCalls).toBe(2);
  });

  it("rejects a malformed plan without breaking the loop", async () => {
    h.turns = [turnWith(call("p1", "update_plan", { steps: "nope" })), text("fine")];
    const ev = await run({ kind: "user", chatId: "c1", content: "x", ...base });
    expect(types(ev)).not.toContain("plan");
    expect(types(ev).at(-1)).toBe("done");
  });

  it("pauses with a step_limit error instead of looping forever", async () => {
    h.turns = Array.from({ length: 20 }, (_, i) => turnWith(call(`r${i}`, "recall", {})));
    const ev = await run({ kind: "user", chatId: "c1", content: "loop", ...base });
    expect(ev.find((e) => e.type === "error")).toMatchObject({ code: "step_limit" });
    expect(h.llmCalls).toBe(8);
  });
});
