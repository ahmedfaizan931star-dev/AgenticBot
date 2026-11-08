import "server-only";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ToolOutput } from "@/lib/connectors/page";
import { allow } from "@/lib/ratelimit";
import { wrapUntrusted } from "@/lib/security/url";
import { McpAuthError, McpPool, callTool, connectMcp, hashTools, listToolSnapshots, type McpConnection } from "./client";
import { buildRegistry, validateMcpArgs, type ResolvedTool } from "./registry";
import { assertPublicUrl, guardedFetch } from "./ssrf";
import { getServer, listServers, loadCredentials, makeOauthProvider, saveDiscovery, setStatus } from "./store";
import type { McpServerInfo } from "./types";

const errText = (e: unknown) => (e instanceof Error ? e.message : "Unknown error").replace(/[\u0000-\u001f]+/g, " ").slice(0, 160);

export async function openConnection(userId: string, server: McpServerInfo): Promise<McpConnection> {
  return connectMcp(server.url, await loadCredentials(userId, server));
}

/** Connects, fetches the tool list and stores it. A changed list pauses the app until the user reviews it again. */
export async function discoverServer(userId: string, id: string): Promise<{ ok: true; server: McpServerInfo } | { ok: false; error: string; needsAuth?: boolean }> {
  const server = await getServer(userId, id);
  if (!server) return { ok: false, error: "App not found." };
  let conn: McpConnection | null = null;
  try {
    conn = await openConnection(userId, server);
    const tools = await listToolSnapshots(conn.client);
    await saveDiscovery(userId, id, tools, hashTools(tools));
    return { ok: true, server: (await getServer(userId, id))! };
  } catch (e) {
    if (e instanceof McpAuthError) {
      await setStatus(userId, id, "needs_auth", "Sign-in needed");
      return { ok: false, error: e.message, needsAuth: true };
    }
    await setStatus(userId, id, "error", errText(e));
    return { ok: false, error: `Could not read the app's tools: ${errText(e)}` };
  } finally {
    await conn?.close();
  }
}

/** Runs one tool the user already allowed. The result is untrusted data and is wrapped as such. */
export async function callResolved(userId: string, r: ResolvedTool, args: Record<string, unknown>, pool: McpPool): Promise<ToolOutput> {
  const v = validateMcpArgs(args);
  if (!v.ok) return { ok: false, text: v.error };
  if (!(await allow(`mcp:${userId}`, 120, 60))) return { ok: false, text: "Too many app calls this minute. Wait a moment." };
  try {
    const conn = await pool.get(r.server.id);
    const out = await callTool(conn, r.tool.name, v.args);
    return { ok: !out.isError, text: wrapUntrusted("connector_data", `${r.server.name}: ${r.tool.name}\n${out.text}`, 13000), summary: `${r.server.name}`.slice(0, 30) };
  } catch (e) {
    if (e instanceof McpAuthError) {
      await setStatus(userId, r.server.id, "needs_auth", "Sign-in needed");
      return { ok: false, text: `${r.server.name} needs the user to sign in again on the Connectors page.` };
    }
    return { ok: false, text: `${r.server.name} did not respond: ${errText(e)}` };
  }
}

/** Used after the user approves: everything is re-checked against the stored, reviewed tool list. */
export async function executeMcp(userId: string, serverId: unknown, toolName: unknown, rawArgs: unknown): Promise<ToolOutput> {
  if (typeof serverId !== "string" || typeof toolName !== "string") return { ok: false, text: "Invalid action." };
  const server = await getServer(userId, serverId);
  if (!server) return { ok: false, text: "That app is no longer connected." };
  const entry = [...buildRegistry([server]).resolve.values()].find((r) => r.tool.name === toolName);
  if (!entry) return { ok: false, text: "That tool is no longer available (switched off, or the app changed and needs review). Nothing was run." };
  const pool = new McpPool(() => openConnection(userId, server));
  try {
    return await callResolved(userId, entry, (rawArgs ?? {}) as Record<string, unknown>, pool);
  } finally {
    await pool.closeAll();
  }
}

export function makePool(userId: string, servers: McpServerInfo[]): McpPool {
  const byId = new Map(servers.map((s) => [s.id, s]));
  return new McpPool((id) => {
    const s = byId.get(id);
    if (!s) return Promise.reject(new Error("Unknown app"));
    return openConnection(userId, s);
  });
}

export const loadRegistry = async (userId: string) => {
  const servers = await listServers(userId);
  return { servers, registry: buildRegistry(servers) };
};

/** Step 1 of OAuth: ask the server to authorize us; the SDK discovers the endpoints and hands back the sign-in URL. */
export async function startOauth(userId: string, id: string): Promise<{ ok: true; redirectTo: string | null } | { ok: false; error: string }> {
  const server = await getServer(userId, id);
  if (!server || server.authType !== "oauth") return { ok: false, error: "App not found." };
  const provider = await makeOauthProvider(userId, id);
  let conn: McpConnection | null = null;
  try {
    conn = await connectMcp(server.url, { kind: "oauth", provider });
    await conn.close();
    conn = null;
    const d = await discoverServer(userId, id);
    return d.ok ? { ok: true, redirectTo: null } : { ok: false, error: d.error };
  } catch (e) {
    if (e instanceof McpAuthError && provider.authorizationUrl) return { ok: true, redirectTo: provider.authorizationUrl };
    return { ok: false, error: `Could not start sign-in: ${errText(e)}` };
  } finally {
    await conn?.close();
  }
}

/** Step 2 of OAuth: the browser came back with a code. The state must match the one we issued, then the SDK exchanges the code. */
export async function finishOauth(userId: string, params: URLSearchParams): Promise<{ ok: true } | { ok: false; error: string }> {
  const returned = params.get("state");
  for (const server of (await listServers(userId)).filter((s) => s.authType === "oauth")) {
    const provider = await makeOauthProvider(userId, server.id);
    if (!provider.consumeState(returned)) continue;
    const checked = assertPublicUrl(server.url);
    if (!checked.ok) return { ok: false, error: checked.reason };
    try {
      const transport = new StreamableHTTPClientTransport(checked.url, { fetch: guardedFetch as never, authProvider: provider });
      await transport.finishAuth(params);
      await provider.clearPending();
    } catch (e) {
      await provider.clearPending();
      return { ok: false, error: `Sign-in failed: ${errText(e)}` };
    }
    const d = await discoverServer(userId, server.id);
    return d.ok ? { ok: true } : { ok: false, error: d.error };
  }
  return { ok: false, error: "This sign-in link is not valid or has expired." };
}
