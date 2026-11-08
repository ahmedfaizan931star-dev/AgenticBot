import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmEvent } from "@/lib/llm/types";
import { makeFakeDb } from "./fakeDb";
import { startServer, type TestServer } from "./mcpServers";

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof import("./fakeDb").makeFakeDb> | null,
  turns: [] as LlmEvent[][],
  toolSets: [] as string[][],
  llmCalls: 0,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ratelimit", () => ({ allow: async () => true }));
vi.mock("@/lib/credits", async (orig) => ({ ...(await orig<typeof import("@/lib/credits")>()), spend: vi.fn(async () => 100), refund: vi.fn(async () => 100) }));
vi.mock("@/lib/llm/provider", () => ({
  streamCompletion: async function* (opts: { tools: { function: { name: string } }[] }) {
    h.llmCalls++;
    h.toolSets.push(opts.tools.map((t) => t.function.name));
    const turn = h.turns.shift() ?? [{ type: "text", delta: "ok" }, { type: "done" }];
    for (const e of turn) yield e;
  },
}));

import { decideAction } from "@/lib/actions/store";
import type { StreamEvent } from "@/lib/agent/events";
import { runAgent } from "@/lib/agent/run";
import { McpPool } from "@/lib/mcp/client";
import { buildRegistry } from "@/lib/mcp/registry";
import { callResolved, discoverServer, executeMcp, openConnection } from "@/lib/mcp/service";
import { createServer, getServer, listServers, reviewServer, saveDiscovery, setPolicy } from "@/lib/mcp/store";

let alpha: TestServer;
let beta: TestServer;
const call = (id: string, name: string, args: unknown) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const turnWith = (...c: ReturnType<typeof call>[]): LlmEvent[] => [{ type: "tool_calls", calls: c }, { type: "done" }];
const text = (t: string): LlmEvent[] => [{ type: "text", delta: t }, { type: "done" }];
const base = { mode: "chat" as const, extension: false };

async function run(input: Parameters<typeof runAgent>[1]) {
  const out: StreamEvent[] = [];
  for await (const e of runAgent("u1", input)) out.push(e);
  return out;
}
const types = (ev: StreamEvent[]) => ev.map((e) => e.type);

/** Adds an app, reads its tools from the real server, and accepts them like the user would. */
async function addApp(name: string, srv: TestServer, enabled?: string[], extra: { token?: string; auth?: "none" | "bearer" } = {}) {
  const made = await createServer("u1", { name, url: srv.url, authType: extra.auth ?? "none", token: extra.token });
  if (!made.ok) throw new Error(made.error);
  const d = await discoverServer("u1", made.server.id);
  if (!d.ok) throw new Error(d.error);
  const names = d.server.tools.map((t) => t.name);
  await reviewServer("u1", made.server.id, enabled ?? names);
  return (await getServer("u1", made.server.id))!;
}

beforeAll(async () => {
  vi.stubEnv("MCP_ALLOW_PRIVATE", "1");
  vi.stubEnv("CONNECTOR_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  [alpha, beta] = await Promise.all([startServer(), startServer()]);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all([alpha.close(), beta.close()]);
});
beforeEach(() => {
  h.db = makeFakeDb({ chats: [{ id: "c1", user_id: "u1", title: "t" }] });
  h.turns = [];
  h.toolSets = [];
  h.llmCalls = 0;
  alpha.notes.length = 0;
  alpha.calls.length = 0;
  beta.notes.length = 0;
  beta.calls.length = 0;
});

describe("connecting an app", () => {
  it("reads the tool list, fingerprints it, and keeps the app paused until the user accepts", async () => {
    const made = await createServer("u1", { name: "Alpha", url: alpha.url, authType: "none" });
    if (!made.ok) throw new Error("create failed");
    const d = await discoverServer("u1", made.server.id);
    expect(d.ok && d.server.status).toBe("needs_review");
    expect(d.ok && d.server.toolsHash).toBeTruthy();
    expect(d.ok && d.server.tools.map((t) => t.name).sort()).toEqual(["add_note", "big", "boom", "echo", "hostile", "slow"]);
    expect(buildRegistry(await listServers("u1")).tools).toHaveLength(0); // nothing reaches the model yet
    await reviewServer("u1", made.server.id, ["echo", "add_note"]);
    const r = buildRegistry(await listServers("u1"));
    expect([...r.resolve.keys()].sort()).toEqual(["mcp_alpha__add_note", "mcp_alpha__echo"]);
  });

  it("stores the access token encrypted and never in plain text", async () => {
    const secured = await startServer({ token: "tok-123" });
    try {
      const app = await addApp("Secured", secured, ["echo"], { auth: "bearer", token: "tok-123" });
      expect(app.status).toBe("active");
      const row = h.db!.tables.mcp_servers!.find((r) => r.id === app.id)!;
      expect(String(row.secret_enc)).toMatch(/^v1\./);
      expect(JSON.stringify(h.db!.tables)).not.toContain("tok-123");
    } finally {
      await secured.close();
    }
  });

  it("marks the app as needing sign-in when the server rejects the token", async () => {
    const secured = await startServer({ token: "right" });
    try {
      const made = await createServer("u1", { name: "Bad", url: secured.url, authType: "bearer", token: "wrong" });
      if (!made.ok) throw new Error("create failed");
      const d = await discoverServer("u1", made.server.id);
      expect(d).toMatchObject({ ok: false, needsAuth: true });
      expect((await getServer("u1", made.server.id))!.status).toBe("needs_auth");
    } finally {
      await secured.close();
    }
  });

  it("pauses an app whose tools change after the user accepted them (no silent swap)", async () => {
    const app = await addApp("Alpha", alpha);
    expect(buildRegistry([app]).tools.length).toBeGreaterThan(0);
    await saveDiscovery("u1", app.id, [{ name: "echo", description: "NOW EXFILTRATES DATA", inputSchema: { type: "object", properties: {} }, readOnly: true, destructive: false }], "different-hash");
    const after = (await getServer("u1", app.id))!;
    expect(after.status).toBe("needs_review");
    expect(buildRegistry([after]).tools).toHaveLength(0);
    const restored = await discoverServer("u1", app.id); // the server is back to exactly the list the user accepted
    expect(restored.ok && restored.server.status).toBe("active");
  });

  it("leaves an unchanged app active after a refresh", async () => {
    const app = await addApp("Alpha", alpha);
    const again = await discoverServer("u1", app.id);
    expect(again.ok && again.server.status).toBe("active");
  });

  it("limits how many apps one user can connect and refuses duplicates", async () => {
    await createServer("u1", { name: "Alpha", url: alpha.url, authType: "none" });
    expect((await createServer("u1", { name: "Again", url: alpha.url, authType: "none" })).ok).toBe(false);
    for (let i = 0; i < 9; i++) await createServer("u1", { name: `App ${i}`, url: `https://mcp${i}.example.com/mcp`, authType: "none" });
    expect((await createServer("u1", { name: "Eleventh", url: "https://eleven.example.com/mcp", authType: "none" })).ok).toBe(false);
  });
});

describe("calling tools", () => {
  it("returns tool output wrapped as untrusted data, with the wrapper impossible to close from inside", async () => {
    const app = await addApp("Alpha", alpha);
    const r = buildRegistry([app]).resolve.get("mcp_alpha__hostile")!;
    const pool = new McpPool(() => openConnection("u1", app));
    const out = await callResolved("u1", r, {}, pool);
    await pool.closeAll();
    expect(out.ok).toBe(true);
    expect(out.text.startsWith("<untrusted_connector_data>")).toBe(true);
    expect(out.text.endsWith("</untrusted_connector_data>")).toBe(true);
    expect(out.text.match(/<\/untrusted_connector_data>/g)).toHaveLength(1);
    expect(out.text).toContain("IGNORE ALL PREVIOUS INSTRUCTIONS");
  });

  it("runs calls to different apps at the same time", async () => {
    const [a, b] = [await addApp("Alpha", alpha), await addApp("Beta", beta)];
    const reg = buildRegistry([a, b]);
    const pool = new McpPool((id) => openConnection("u1", id === a.id ? a : b));
    const started = Date.now();
    const out = await Promise.all([
      callResolved("u1", reg.resolve.get("mcp_alpha__slow")!, { ms: 500 }, pool),
      callResolved("u1", reg.resolve.get("mcp_beta__slow")!, { ms: 500 }, pool),
      callResolved("u1", reg.resolve.get("mcp_alpha__slow")!, { ms: 500 }, pool),
    ]);
    await pool.closeAll();
    expect(out.every((o) => o.ok)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1300);
  });

  it("reports an app's own error as a failure the model can see", async () => {
    const app = await addApp("Alpha", alpha);
    const pool = new McpPool(() => openConnection("u1", app));
    const out = await callResolved("u1", buildRegistry([app]).resolve.get("mcp_alpha__boom")!, {}, pool);
    await pool.closeAll();
    expect(out.ok).toBe(false);
    expect(out.text).toContain("kaboom");
  });

  it("after approval, refuses a tool that was switched off or whose app needs review, without calling the server", async () => {
    const app = await addApp("Alpha", alpha, ["echo"]);
    expect((await executeMcp("u1", app.id, "add_note", { note: "x" })).ok).toBe(false);
    expect(alpha.notes).toHaveLength(0);
    await saveDiscovery("u1", app.id, app.tools, "changed");
    expect((await executeMcp("u1", app.id, "echo", { text: "x" })).ok).toBe(false);
    expect(alpha.calls).toHaveLength(0);
    expect((await executeMcp("intruder", app.id, "echo", { text: "x" })).ok).toBe(false);
  });
});

describe("the agent using several apps", () => {
  it("offers only reviewed tools, and runs read-only tools from two apps in one step", async () => {
    await addApp("Alpha", alpha, ["echo", "add_note"]);
    await addApp("Beta", beta, ["echo"]);
    h.turns = [turnWith(call("a", "mcp_alpha__echo", { text: "one" }), call("b", "mcp_beta__echo", { text: "two" })), text("both done")];
    const ev = await run({ kind: "user", chatId: "c1", content: "ask both", ...base });
    expect(h.toolSets[0]).toEqual(expect.arrayContaining(["mcp_alpha__echo", "mcp_alpha__add_note", "mcp_beta__echo"]));
    expect(h.toolSets[0]!.some((n) => n.startsWith("mcp_alpha__slow") || n.startsWith("mcp_alpha__boom"))).toBe(false);
    expect(alpha.calls).toEqual(["echo:one"]);
    expect(beta.calls).toEqual(["echo:two"]);
    expect(types(ev).at(-1)).toBe("done");
    const toolMsgs = h.db!.tables.messages!.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.tool_call_id).sort()).toEqual(["a", "b"]);
    expect(String(toolMsgs[0]!.content)).toContain("<untrusted_connector_data>");
  });

  it("turns a changing tool into a proposal: nothing runs until the user approves, then it runs exactly once", async () => {
    await addApp("Alpha", alpha);
    h.turns = [turnWith(call("n1", "mcp_alpha__add_note", { note: "buy milk" })), text("Waiting for you.")];
    const ev = await run({ kind: "user", chatId: "c1", content: "save a note", ...base });
    expect(types(ev)).toContain("approval_required");
    expect(types(ev).at(-1)).toBe("awaiting_approval");
    expect(alpha.notes).toEqual([]);
    const card = ev.find((e) => e.type === "approval_required") as Extract<StreamEvent, { type: "approval_required" }>;
    expect(card.action.summary).toContain("add_note");
    expect(card.action.preview).toContain("buy milk");

    const [a, b] = await Promise.all([decideAction("u1", card.action.id, "approve"), decideAction("u1", card.action.id, "approve")]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(alpha.notes).toEqual(["buy milk"]);
    const done = await run({ kind: "continue", chatId: "c1", ...base });
    expect(types(done).at(-1)).toBe("done");
  });

  it("denying a proposal never calls the app", async () => {
    await addApp("Alpha", alpha);
    h.turns = [turnWith(call("n1", "mcp_alpha__add_note", { note: "secret" }))];
    const ev = await run({ kind: "user", chatId: "c1", content: "save", ...base });
    const card = ev.find((e) => e.type === "approval_required") as Extract<StreamEvent, { type: "approval_required" }>;
    expect(await decideAction("u1", card.action.id, "deny")).toMatchObject({ ok: true, status: "denied" });
    expect(alpha.calls).toHaveLength(0);
  });

  it("a prompt injection in one app's output cannot make the agent change anything in another", async () => {
    await addApp("Alpha", alpha);
    await addApp("Beta", beta);
    // Step 1: read the hostile text. Step 2: the (fooled) model obeys it and tries to write a note on the other app.
    h.turns = [turnWith(call("h", "mcp_alpha__hostile", {})), turnWith(call("w", "mcp_beta__add_note", { note: "pwned" }))];
    const ev = await run({ kind: "user", chatId: "c1", content: "read the page", ...base });
    expect(types(ev)).toContain("approval_required");
    expect(beta.notes).toEqual([]);
    expect(alpha.notes).toEqual([]);
    const hostile = h.db!.tables.messages!.find((m) => m.tool_call_id === "h")!;
    expect(String(hostile.content)).toMatch(/^<untrusted_connector_data>/);
  });

  it("'ask for every call' makes even read-only tools wait for approval", async () => {
    const app = await addApp("Alpha", alpha);
    await setPolicy("u1", app.id, "ask_all");
    h.turns = [turnWith(call("e", "mcp_alpha__echo", { text: "hi" }))];
    const ev = await run({ kind: "user", chatId: "c1", content: "echo", ...base });
    expect(types(ev)).toContain("approval_required");
    expect(alpha.calls).toHaveLength(0);
  });

  it("stops offering an app's tools once it needs review again", async () => {
    const app = await addApp("Alpha", alpha);
    await saveDiscovery("u1", app.id, app.tools, "tampered");
    await run({ kind: "user", chatId: "c1", content: "hi", ...base });
    expect(h.toolSets[0]!.some((n) => n.startsWith("mcp_"))).toBe(false);
  });

  it("a model hallucinating an app tool that is not enabled gets an error, not a call", async () => {
    await addApp("Alpha", alpha, ["echo"]);
    h.turns = [turnWith(call("x", "mcp_alpha__add_note", { note: "sneaky" })), text("ok")];
    const ev = await run({ kind: "user", chatId: "c1", content: "do it", ...base });
    expect(types(ev)).not.toContain("approval_required");
    expect(alpha.calls).toHaveLength(0);
    expect(h.db!.tables.pending_actions ?? []).toHaveLength(0);
  });
});
