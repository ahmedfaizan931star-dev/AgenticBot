import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { McpAuthError, McpPool, callTool, connectMcp, hashTools, listToolSnapshots } from "@/lib/mcp/client";
import { startServer, type TestServer } from "./mcpServers";

let modern: TestServer;
let legacy: TestServer;
let secured: TestServer;

beforeAll(async () => {
  vi.stubEnv("MCP_ALLOW_PRIVATE", "1");
  [modern, legacy, secured] = await Promise.all([startServer(), startServer({ tools: "v1" }), startServer({ token: "s3cret" })]);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all([modern.close(), legacy.close(), secured.close()]);
});

describe("MCP client against a real server (2026-07-28 SDK)", () => {
  it("connects, lists tools with their read-only hints, and calls them", async () => {
    const conn = await connectMcp(modern.url, { kind: "none" });
    try {
      const tools = await listToolSnapshots(conn.client);
      expect(tools.map((t) => t.name).sort()).toEqual(["add_note", "big", "boom", "echo", "hostile", "slow"]);
      expect(tools.find((t) => t.name === "echo")).toMatchObject({ readOnly: true, destructive: false });
      expect(tools.find((t) => t.name === "add_note")!.readOnly).toBe(false);
      expect(tools.find((t) => t.name === "echo")!.inputSchema).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
      expect(await callTool(conn, "echo", { text: "hi" })).toEqual({ text: "echo: hi", isError: false });
    } finally {
      await conn.close();
    }
  });

  it("reports tool errors as errors and caps huge output", async () => {
    const conn = await connectMcp(modern.url, { kind: "none" });
    try {
      expect(await callTool(conn, "boom", {})).toEqual({ text: "kaboom", isError: true });
      const big = await callTool(conn, "big", {});
      expect(big.text.length).toBe(12_000);
    } finally {
      await conn.close();
    }
  });

  it("also works with an older (2025-era) server built on the v1 SDK", async () => {
    const conn = await connectMcp(legacy.url, { kind: "none" });
    try {
      const tools = await listToolSnapshots(conn.client);
      expect(tools.map((t) => t.name).sort()).toEqual(["add_note", "echo"]);
      expect(await callTool(conn, "echo", { text: "old" })).toEqual({ text: "echo: old", isError: false });
    } finally {
      await conn.close();
    }
  });

  it("sends the bearer token, and signals an auth problem instead of a vague failure", async () => {
    const ok = await connectMcp(secured.url, { kind: "bearer", token: "s3cret" });
    expect((await listToolSnapshots(ok.client)).length).toBeGreaterThan(0);
    await ok.close();
    await expect(connectMcp(secured.url, { kind: "bearer", token: "wrong" })).rejects.toBeInstanceOf(McpAuthError);
    await expect(connectMcp(secured.url, { kind: "none" })).rejects.toBeInstanceOf(McpAuthError);
  });

  it("runs concurrent calls over one shared session (parallel, not queued)", async () => {
    const pool = new McpPool((id) => connectMcp(id, { kind: "none" }));
    const started = Date.now();
    const results = await Promise.all([1, 2, 3, 4].map(async () => callTool(await pool.get(modern.url), "slow", { ms: 400 })));
    const elapsed = Date.now() - started;
    expect(results.every((r) => r.text === "waited 400")).toBe(true);
    expect(elapsed).toBeLessThan(1300); // four 400 ms calls would take 1600 ms one after another
    await pool.closeAll();
  });

  it("refuses private addresses unless the test switch is on", async () => {
    vi.stubEnv("MCP_ALLOW_PRIVATE", "0");
    await expect(connectMcp(modern.url, { kind: "none" })).rejects.toThrow(/https|private/);
    vi.stubEnv("MCP_ALLOW_PRIVATE", "1");
  });
});

describe("tool fingerprint", () => {
  const base = [{ name: "a", description: "d", inputSchema: { type: "object" }, readOnly: true, destructive: false }];
  it("is stable and changes when anything the model sees changes", () => {
    expect(hashTools(base)).toBe(hashTools([...base]));
    for (const changed of [{ description: "d2" }, { inputSchema: { type: "object", properties: { x: {} } } }, { readOnly: false }, { name: "b" }]) {
      expect(hashTools([{ ...base[0]!, ...changed }])).not.toBe(hashTools(base));
    }
    expect(hashTools([...base, { ...base[0]!, name: "z" }])).not.toBe(hashTools(base));
  });
});
