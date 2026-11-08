import "server-only";
import { decrypt, encrypt } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Credentials } from "./client";
import { DbOAuthProvider, type OAuthBlob } from "./oauth";
import type { McpAuthType, McpPolicy, McpServerInfo, McpStatus, ToolSnapshot } from "./types";

export const MAX_SERVERS = 10;
const COLUMNS = "id, user_id, name, slug, url, auth_type, policy, status, tools, enabled_tools, tools_hash, reviewed_hash, last_error";

type Row = { id: string; user_id: string; name: string; slug: string; url: string; auth_type: McpAuthType; policy: McpPolicy; status: McpStatus; tools: unknown; enabled_tools: unknown; tools_hash: string | null; reviewed_hash: string | null; last_error: string | null };

const toInfo = (r: Row): McpServerInfo => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  slug: r.slug,
  url: r.url,
  authType: r.auth_type,
  policy: r.policy,
  status: r.status,
  tools: Array.isArray(r.tools) ? (r.tools as ToolSnapshot[]) : [],
  enabledTools: Array.isArray(r.enabled_tools) ? (r.enabled_tools as string[]) : [],
  toolsHash: r.tools_hash,
  reviewedHash: r.reviewed_hash,
  lastError: r.last_error,
});

export async function listServers(userId: string): Promise<McpServerInfo[]> {
  const { data } = await createAdminClient().from("mcp_servers").select(COLUMNS).eq("user_id", userId).order("created_at", { ascending: true });
  return ((data ?? []) as Row[]).map(toInfo);
}

export async function getServer(userId: string, id: string): Promise<McpServerInfo | null> {
  const { data } = await createAdminClient().from("mcp_servers").select(COLUMNS).eq("user_id", userId).eq("id", id).maybeSingle();
  return data ? toInfo(data as Row) : null;
}

export function slugify(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 16) || "app";
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}_${i}`;
  return slug;
}

export async function createServer(userId: string, v: { name: string; url: string; authType: McpAuthType; token?: string; policy?: McpPolicy }): Promise<{ ok: true; server: McpServerInfo } | { ok: false; error: string }> {
  const existing = await listServers(userId);
  if (existing.length >= MAX_SERVERS) return { ok: false, error: `You can connect up to ${MAX_SERVERS} apps.` };
  if (existing.some((s) => s.url === v.url)) return { ok: false, error: "That server is already connected." };
  const slug = slugify(v.name, new Set(existing.map((s) => s.slug)));
  const { data, error } = await createAdminClient()
    .from("mcp_servers")
    .insert({ user_id: userId, name: v.name, slug, url: v.url, auth_type: v.authType, secret_enc: v.token ? encrypt(v.token) : null, policy: v.policy ?? "ask_unless_readonly", status: v.authType === "oauth" ? "needs_auth" : "needs_review" })
    .select(COLUMNS)
    .single();
  if (error || !data) return { ok: false, error: "Could not save the server." };
  return { ok: true, server: toInfo(data as Row) };
}

export async function setStatus(userId: string, id: string, status: McpStatus, lastError: string | null = null) {
  await createAdminClient().from("mcp_servers").update({ status, last_error: lastError, updated_at: new Date().toISOString() }).eq("id", id).eq("user_id", userId);
}

/** Saves a freshly fetched tool list. If it differs from what the user last accepted, the app pauses until re-reviewed. */
export async function saveDiscovery(userId: string, id: string, tools: ToolSnapshot[], hash: string) {
  const current = await getServer(userId, id);
  if (!current) return;
  const unchanged = current.reviewedHash === hash;
  await createAdminClient()
    .from("mcp_servers")
    .update({ tools, tools_hash: hash, status: unchanged ? "active" : "needs_review", last_error: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId);
}

export async function reviewServer(userId: string, id: string, enabled: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await getServer(userId, id);
  if (!s || !s.toolsHash) return { ok: false, error: "Fetch the tool list first." };
  const names = new Set(s.tools.map((t) => t.name));
  const picked = [...new Set(enabled)].filter((n) => names.has(n));
  await createAdminClient()
    .from("mcp_servers")
    .update({ reviewed_hash: s.toolsHash, enabled_tools: picked, status: "active", last_error: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId);
  return { ok: true };
}

export async function setPolicy(userId: string, id: string, policy: McpPolicy) {
  await createAdminClient().from("mcp_servers").update({ policy, updated_at: new Date().toISOString() }).eq("id", id).eq("user_id", userId);
}

export async function deleteServer(userId: string, id: string) {
  await createAdminClient().from("mcp_servers").delete().eq("id", id).eq("user_id", userId);
}

async function readSecrets(userId: string, id: string) {
  const { data } = await createAdminClient().from("mcp_servers").select("auth_type, secret_enc, oauth_enc").eq("id", id).eq("user_id", userId).maybeSingle();
  return data;
}

export async function loadOauthBlob(userId: string, id: string): Promise<OAuthBlob> {
  const d = await readSecrets(userId, id);
  if (!d?.oauth_enc) return {};
  try {
    return JSON.parse(decrypt(d.oauth_enc)) as OAuthBlob;
  } catch {
    return {};
  }
}

export async function saveOauthBlob(userId: string, id: string, blob: OAuthBlob) {
  await createAdminClient().from("mcp_servers").update({ oauth_enc: encrypt(JSON.stringify(blob)), updated_at: new Date().toISOString() }).eq("id", id).eq("user_id", userId);
}

export async function makeOauthProvider(userId: string, id: string): Promise<DbOAuthProvider> {
  return new DbOAuthProvider(await loadOauthBlob(userId, id), (b) => saveOauthBlob(userId, id, b));
}

export async function loadCredentials(userId: string, server: McpServerInfo): Promise<Credentials> {
  if (server.authType === "none") return { kind: "none" };
  if (server.authType === "oauth") return { kind: "oauth", provider: await makeOauthProvider(userId, server.id) };
  const d = await readSecrets(userId, server.id);
  if (!d?.secret_enc) return { kind: "none" };
  try {
    return { kind: "bearer", token: decrypt(d.secret_enc) };
  } catch {
    return { kind: "none" };
  }
}

export async function replaceToken(userId: string, id: string, token: string) {
  await createAdminClient().from("mcp_servers").update({ secret_enc: encrypt(token), status: "needs_review", updated_at: new Date().toISOString() }).eq("id", id).eq("user_id", userId);
}
