import "server-only";
import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type AuthProvider, type OAuthClientProvider } from "@modelcontextprotocol/client";
import { assertPublicUrl, guardedFetch } from "./ssrf";
import type { ToolSnapshot } from "./types";

export class McpAuthError extends Error {
  constructor() {
    super("This server needs you to sign in again.");
  }
}

const CONNECT_TIMEOUT = 15_000;
const LIST_TIMEOUT = 15_000;
export const CALL_TIMEOUT = 25_000;
const MAX_TOOLS = 100;
const MAX_RESULT_CHARS = 12_000;

export type Credentials = { kind: "none" } | { kind: "bearer"; token: string } | { kind: "oauth"; provider: OAuthClientProvider };
export type McpConnection = { client: Client; close: () => Promise<void> };

/** Opens a session to a remote MCP server. Older (2025) and newer (2026-07-28) servers are both handled by the SDK. */
export async function connectMcp(rawUrl: string, creds: Credentials): Promise<McpConnection> {
  const checked = assertPublicUrl(rawUrl);
  if (!checked.ok) throw new Error(checked.reason);
  const authProvider: AuthProvider | OAuthClientProvider | undefined =
    creds.kind === "bearer" ? { token: async () => creds.token } : creds.kind === "oauth" ? creds.provider : undefined;
  const transport = new StreamableHTTPClientTransport(checked.url, { fetch: guardedFetch as never, authProvider, redirectPolicy: "same-origin" });
  const client = new Client({ name: "agent-hub", version: "0.4.0" }, { versionNegotiation: { mode: "auto" } });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT });
  } catch (e) {
    await client.close().catch(() => undefined);
    if (e instanceof UnauthorizedError || (e as { data?: { status?: number } })?.data?.status === 401) throw new McpAuthError();
    throw e;
  }
  return { client, close: () => client.close().catch(() => undefined) };
}

const clip = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, n) : "");

export async function listToolSnapshots(client: Client): Promise<ToolSnapshot[]> {
  const res = await client.listTools(undefined, { timeout: LIST_TIMEOUT });
  const out: ToolSnapshot[] = [];
  for (const t of res.tools.slice(0, MAX_TOOLS)) {
    const name = clip(t.name, 128);
    if (!name) continue;
    const schema = t.inputSchema && typeof t.inputSchema === "object" ? (t.inputSchema as Record<string, unknown>) : { type: "object", properties: {} };
    out.push({
      name,
      description: clip(t.description ?? t.title, 600),
      inputSchema: JSON.stringify(schema).length <= 16_000 ? schema : { type: "object", properties: {} },
      readOnly: t.annotations?.readOnlyHint === true,
      destructive: t.annotations?.destructiveHint === true,
    });
  }
  return out;
}

/** Stable fingerprint of what the model is allowed to see. Any change to a tool's name, text, schema or hints changes it. */
export function hashTools(tools: ToolSnapshot[]): string {
  const canon = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.name, t.description, t.inputSchema, t.readOnly, t.destructive]);
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 32);
}

type Block = { type?: string; text?: string; resource?: { text?: string; uri?: string }; uri?: string; mimeType?: string };

/** Turns a tool result into plain text for the model. Binary content is described, never inlined. */
export function renderToolResult(result: { content?: unknown; structuredContent?: unknown; isError?: boolean }): { text: string; isError: boolean } {
  const parts: string[] = [];
  for (const b of (Array.isArray(result.content) ? result.content : []) as Block[]) {
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "resource" && b.resource) parts.push(b.resource.text ?? `[resource ${b.resource.uri ?? ""}]`);
    else if (b.type === "resource_link") parts.push(`[link ${b.uri ?? ""}]`);
    else if (b.type === "image" || b.type === "audio") parts.push(`[${b.type} ${b.mimeType ?? ""} omitted]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join("\n").trim();
  return { text: (text || "(no output)").slice(0, MAX_RESULT_CHARS), isError: result.isError === true };
}

export async function callTool(conn: McpConnection, name: string, args: Record<string, unknown>) {
  const res = await conn.client.callTool({ name, arguments: args }, { timeout: CALL_TIMEOUT });
  return renderToolResult(res as never);
}

/** One session per server for a whole request, shared by every concurrent call to that server. */
export class McpPool {
  private conns = new Map<string, Promise<McpConnection>>();
  constructor(private open: (serverId: string) => Promise<McpConnection>) {}
  get(serverId: string): Promise<McpConnection> {
    let p = this.conns.get(serverId);
    if (!p) {
      p = this.open(serverId);
      this.conns.set(serverId, p);
      p.catch(() => this.conns.delete(serverId));
    }
    return p;
  }
  async closeAll() {
    const all = [...this.conns.values()];
    this.conns.clear();
    await Promise.all(all.map((p) => p.then((c) => c.close()).catch(() => undefined)));
  }
}
