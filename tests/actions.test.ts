import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb } from "./fakeDb";

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof import("./fakeDb").makeFakeDb> | null,
  status: {} as Record<string, { label: string | null; mode: "read" | "write" } | undefined>,
  allow: true,
  githubWrite: vi.fn(),
  driveWrite: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ratelimit", () => ({ allow: async () => h.allow }));
vi.mock("@/lib/connectors/store", () => ({ connectionStatus: async () => h.status }));
vi.mock("@/lib/connectors/write", () => ({ githubWrite: h.githubWrite, driveWrite: h.driveWrite }));

import { decideAction, expirePending, proposeAction } from "@/lib/actions/store";

const GOOD = { repo: "o/r", path: "docs/a.md", content: "hello", message: "Add docs", branch: "agent/docs" };
const past = () => new Date(Date.now() - 1000).toISOString();

function seedAction(over: Record<string, unknown> = {}) {
  return { id: "act-1", user_id: "u1", chat_id: "c1", tool_call_id: "call-1", tool: "github_commit_file", args: GOOD, summary: "s", preview: "p", status: "pending", result: null, expires_at: new Date(Date.now() + 600_000).toISOString(), ...over };
}
const toolMsg = () => ({ id: "m1", chat_id: "c1", user_id: "u1", role: "tool", tool_call_id: "call-1", content: "Waiting", is_error: false });

beforeEach(() => {
  h.status = { github: { label: "me", mode: "write" } };
  h.allow = true;
  h.githubWrite.mockReset().mockResolvedValue({ ok: true, text: "Committed" });
  h.driveWrite.mockReset();
  h.db = makeFakeDb({ pending_actions: [], messages: [toolMsg()] }, { unique: { pending_actions: ["chat_id", "tool_call_id"] } });
});

describe("proposeAction", () => {
  it("stores a valid proposal as pending and runs nothing", async () => {
    const r = await proposeAction("u1", "c1", "call-1", "github_commit_file", GOOD);
    expect(r.ok && r.action.summary).toContain("agent/docs");
    expect(h.db!.tables.pending_actions).toHaveLength(1);
    expect(h.db!.tables.pending_actions![0]).toMatchObject({ status: "pending", user_id: "u1" });
    expect(h.githubWrite).not.toHaveBeenCalled();
  });
  it("rejects dangerous arguments without storing anything", async () => {
    for (const bad of [{ ...GOOD, branch: "main" }, { ...GOOD, path: ".github/workflows/x.yml" }, { ...GOOD, repo: "../x" }]) {
      expect((await proposeAction("u1", "c1", "c", "github_commit_file", bad)).ok).toBe(false);
    }
    expect(h.db!.tables.pending_actions).toHaveLength(0);
  });
  it("needs a write-enabled connection", async () => {
    h.status = { github: { label: "me", mode: "read" } };
    expect((await proposeAction("u1", "c1", "c", "github_commit_file", GOOD)).ok).toBe(false);
    h.status = {};
    expect((await proposeAction("u1", "c1", "c", "github_commit_file", GOOD)).ok).toBe(false);
    expect(h.db!.tables.pending_actions).toHaveLength(0);
  });
  it("is rate limited", async () => {
    h.allow = false;
    expect((await proposeAction("u1", "c1", "c", "github_commit_file", GOOD)).ok).toBe(false);
  });
});

describe("decideAction", () => {
  beforeEach(() => {
    h.db = makeFakeDb({ pending_actions: [seedAction()], messages: [toolMsg()] });
  });

  it("approve runs the stored action once and updates the tool message", async () => {
    const r = await decideAction("u1", "act-1", "approve");
    expect(r).toMatchObject({ ok: true, status: "done" });
    expect(h.githubWrite).toHaveBeenCalledTimes(1);
    expect(h.githubWrite).toHaveBeenCalledWith("u1", "github_commit_file", expect.objectContaining({ branch: "agent/docs" }));
    expect(h.db!.tables.messages![0]!.content).toMatch(/Approved and done/);
    expect(h.db!.tables.pending_actions![0]!.status).toBe("done");
  });

  it("two simultaneous approvals execute exactly once", async () => {
    const [a, b] = await Promise.all([decideAction("u1", "act-1", "approve"), decideAction("u1", "act-1", "approve")]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(h.githubWrite).toHaveBeenCalledTimes(1);
  });

  it("cannot be approved again after it is done", async () => {
    await decideAction("u1", "act-1", "approve");
    const again = await decideAction("u1", "act-1", "approve");
    expect(again).toMatchObject({ ok: false, code: "conflict" });
    expect(h.githubWrite).toHaveBeenCalledTimes(1);
  });

  it("deny never executes and tells the model nothing changed", async () => {
    expect(await decideAction("u1", "act-1", "deny")).toMatchObject({ ok: true, status: "denied" });
    expect(h.githubWrite).not.toHaveBeenCalled();
    expect(h.db!.tables.messages![0]!.content).toMatch(/denied/);
    expect(h.db!.tables.messages![0]!.is_error).toBe(true);
  });

  it("another user cannot decide someone else's action", async () => {
    expect(await decideAction("intruder", "act-1", "approve")).toMatchObject({ ok: false, code: "not_found" });
    expect(h.githubWrite).not.toHaveBeenCalled();
    expect(h.db!.tables.pending_actions![0]!.status).toBe("pending");
  });

  it("expired actions are refused", async () => {
    h.db = makeFakeDb({ pending_actions: [seedAction({ expires_at: past() })], messages: [toolMsg()] });
    expect(await decideAction("u1", "act-1", "approve")).toMatchObject({ ok: false, code: "expired" });
    expect(h.githubWrite).not.toHaveBeenCalled();
    expect(h.db!.tables.pending_actions![0]!.status).toBe("expired");
  });

  it("re-validates stored arguments before running (tampered rows are refused)", async () => {
    h.db = makeFakeDb({ pending_actions: [seedAction({ args: { ...GOOD, branch: "main" } })], messages: [toolMsg()] });
    const r = await decideAction("u1", "act-1", "approve");
    expect(r).toMatchObject({ ok: true, status: "failed" });
    expect(h.githubWrite).not.toHaveBeenCalled();
  });

  it("reports failure honestly and never says it succeeded", async () => {
    h.githubWrite.mockResolvedValue({ ok: false, text: "GitHub refused" });
    expect(await decideAction("u1", "act-1", "approve")).toMatchObject({ ok: true, status: "failed" });
    expect(h.db!.tables.messages![0]!.content).toMatch(/failed/);
    expect(h.db!.tables.messages![0]!.is_error).toBe(true);
  });

  it("survives the executor throwing", async () => {
    h.githubWrite.mockRejectedValue(new Error("boom"));
    expect(await decideAction("u1", "act-1", "approve")).toMatchObject({ ok: true, status: "failed" });
  });
});

describe("expirePending", () => {
  it("expires waiting actions when the user moves on", async () => {
    h.db = makeFakeDb({ pending_actions: [seedAction(), seedAction({ id: "act-2", tool_call_id: "call-2", status: "done" })], messages: [toolMsg()] });
    await expirePending("u1", "c1");
    expect(h.db.tables.pending_actions!.map((a) => a.status)).toEqual(["expired", "done"]);
    expect(h.db.tables.messages![0]!.content).toMatch(/Not approved/);
  });
});
