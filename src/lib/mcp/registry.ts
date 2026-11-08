import { createHash } from "node:crypto";
import type { ToolDef } from "@/lib/llm/types";
import type { McpServerInfo, ToolSnapshot } from "./types";

export type ResolvedTool = { server: McpServerInfo; tool: ToolSnapshot; needsApproval: boolean };
export type McpRegistry = { tools: ToolDef[]; resolve: Map<string, ResolvedTool> };

const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 6);
const clean = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/** Provider-safe tool name: only [a-zA-Z0-9_-], at most 64 characters, always prefixed with the app so apps cannot collide. */
export function exposedName(slug: string, tool: string): string {
  const prefix = `mcp_${slug}__`;
  const safe = tool.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = prefix + safe;
  if (full.length <= 64 && safe === tool) return full;
  return `${(prefix + safe).slice(0, 57)}_${short(`${slug}/${tool}`)}`;
}

/** Keeps only the JSON Schema parts every model provider accepts. MCP servers send arbitrary schemas. */
export function providerSafeSchema(schema: unknown, depth = 0): Record<string, unknown> {
  const DROP = new Set(["$schema", "$id", "$comment", "$defs", "definitions", "additionalProperties", "examples", "default", "patternProperties", "unevaluatedProperties"]);
  const walk = (v: unknown, d: number): unknown => {
    if (d > 8) return undefined;
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, d + 1));
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (DROP.has(k) || k === "$ref") continue;
        const w = walk(val, d + 1);
        if (w !== undefined) o[k] = w;
      }
      return o;
    }
    return v;
  };
  const out = walk(schema, depth);
  const obj = out && typeof out === "object" && !Array.isArray(out) ? (out as Record<string, unknown>) : {};
  return { ...obj, type: "object", properties: (obj.properties as Record<string, unknown>) ?? {} };
}

export function needsApproval(server: Pick<McpServerInfo, "policy">, tool: Pick<ToolSnapshot, "readOnly" | "destructive">): boolean {
  if (server.policy === "ask_all") return true;
  return !tool.readOnly || tool.destructive;
}

/**
 * Only tools the user reviewed are exposed: the server must be active, its tool list must still match the version the
 * user accepted (a changed list pauses the app until re-reviewed), and the individual tool must be switched on.
 */
export function buildRegistry(servers: McpServerInfo[]): McpRegistry {
  const tools: ToolDef[] = [];
  const resolve = new Map<string, ResolvedTool>();
  for (const server of servers) {
    if (server.status !== "active" || !server.toolsHash || server.toolsHash !== server.reviewedHash) continue;
    const enabled = new Set(server.enabledTools);
    for (const tool of server.tools) {
      if (!enabled.has(tool.name)) continue;
      const name = exposedName(server.slug, tool.name);
      if (resolve.has(name)) continue;
      resolve.set(name, { server, tool, needsApproval: needsApproval(server, tool) });
      tools.push({
        type: "function",
        function: { name, description: `[${clean(server.name, 40)}] ${clean(tool.description, 400)}`.trim(), parameters: providerSafeSchema(tool.inputSchema) },
      });
    }
  }
  return { tools, resolve };
}

/** Argument sanity before anything leaves for a third-party server: plain JSON object, bounded size and depth. */
export function validateMcpArgs(args: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, error: "Arguments must be an object" };
  let size = 0;
  const walk = (v: unknown, d: number): boolean => {
    if (d > 8) return false;
    if (typeof v === "string") size += v.length;
    else if (Array.isArray(v)) return v.length <= 500 && v.every((x) => walk(x, d + 1));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "__proto__" || k === "constructor" || k === "prototype") return false;
        size += k.length;
        if (!walk(x, d + 1)) return false;
      }
    }
    return size <= 50_000;
  };
  return walk(args, 0) ? { ok: true, args: args as Record<string, unknown> } : { ok: false, error: "Arguments are too large or too deeply nested" };
}
