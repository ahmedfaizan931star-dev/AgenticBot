import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { extractFromBuffer } from "@/lib/files/extract";
import { wrapUntrusted } from "@/lib/security/url";
import { pageText, type ToolOutput } from "./page";
import { deleteConnection, loadConnection, saveConnection } from "./store";

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const WRITE_SCOPE = "https://www.googleapis.com/auth/drive.file"; // only files this app creates; never the rest of the Drive
const TIMEOUT = 15_000;
const MAX_DOWNLOAD = 10 * 1024 * 1024;

export const googleConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export function redirectUri(): string {
  return `${(process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "")}/api/connectors/google/callback`;
}

export function newPkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), state: randomBytes(24).toString("base64url") };
}

export function authUrl(state: string, challenge: string, mode: "read" | "write" = "read"): string {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: mode === "write" ? `${SCOPE} ${WRITE_SCOPE}` : SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse | null> {
  const res = await timedFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "", ...body }),
  });
  const json = (await res.json().catch(() => null)) as TokenResponse | null;
  return res.ok && json?.access_token ? json : null;
}

export async function completeOAuth(userId: string, code: string, verifier: string, mode: "read" | "write" = "read"): Promise<boolean> {
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: verifier });
  if (!t?.access_token) return false;
  const granted = t.scope?.split(" ") ?? [];
  if (!granted.includes(SCOPE)) return false; // user unticked the permission
  const effective: "read" | "write" = mode === "write" && granted.includes(WRITE_SCOPE) ? "write" : "read";
  let label: string | null = null;
  try {
    const about = await timedFetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    label = ((await about.json()) as { user?: { emailAddress?: string } }).user?.emailAddress ?? null;
  } catch {
    // label is cosmetic
  }
  await saveConnection(userId, "google", {
    token: t.access_token,
    refresh: t.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000),
    label,
    scopes: t.scope,
    mode: effective,
  });
  return true;
}

export async function revokeGoogle(userId: string) {
  const c = await loadConnection(userId, "google");
  if (c) {
    await timedFetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: c.refresh ?? c.token }),
    }).catch(() => null);
  }
  await deleteConnection(userId, "google");
}

export async function accessToken(userId: string): Promise<string | null> {
  const c = await loadConnection(userId, "google");
  if (!c) return null;
  if (c.expiresAt && c.expiresAt.getTime() - 60_000 > Date.now()) return c.token;
  if (!c.refresh) return null;
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: c.refresh });
  if (!t?.access_token) return null;
  await saveConnection(userId, "google", {
    token: t.access_token,
    refresh: c.refresh,
    expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000),
    label: c.label,
  });
  return t.access_token;
}

const NOT_CONNECTED: ToolOutput = { ok: false, text: "Google Drive is not connected or access expired. Ask the user to reconnect it on the Connectors page." };

/** Escapes a value for use inside a single-quoted Drive search string. */
export function escapeDriveQuery(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/[\r\n]+/g, " ").slice(0, 200);
}

export async function driveSearch(userId: string, query: unknown): Promise<ToolOutput> {
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) return { ok: false, text: "Missing query" };
  const token = await accessToken(userId);
  if (!token) return NOT_CONNECTED;
  const params = new URLSearchParams({
    q: `fullText contains '${escapeDriveQuery(q)}' and trashed = false`,
    pageSize: "10",
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
  });
  const res = await timedFetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { ok: false, text: `Google Drive search failed (${res.status}).` };
  const { files = [] } = (await res.json()) as { files?: { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string }[] };
  if (files.length === 0) return { ok: true, text: "No matching files.", summary: "No files found" };
  const body = files.map((f, i) => `${i + 1}. ${f.name}\nid: ${f.id}\ntype: ${f.mimeType}\nmodified: ${f.modifiedTime ?? "?"}\n${f.webViewLink ?? ""}`).join("\n\n");
  return { ok: true, text: wrapUntrusted("connector_data", body), summary: `${files.length} files` };
}

const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

export async function driveRead(userId: string, fileId: unknown, offset: unknown): Promise<ToolOutput> {
  if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]{10,120}$/.test(fileId)) return { ok: false, text: "Invalid file id" };
  const token = await accessToken(userId);
  if (!token) return NOT_CONNECTED;
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const metaRes = await timedFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size`, auth);
  if (!metaRes.ok) return { ok: false, text: metaRes.status === 404 ? "File not found." : `Could not open the file (${metaRes.status}).` };
  const meta = (await metaRes.json()) as { name: string; mimeType: string; size?: string };

  const exportAs = EXPORTS[meta.mimeType];
  const url = exportAs
    ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportAs)}`
    : meta.mimeType.startsWith("application/vnd.google-apps.")
      ? null
      : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  if (!url) return { ok: false, text: "This Google file type cannot be read as text." };
  if (meta.size && Number(meta.size) > MAX_DOWNLOAD) return { ok: false, text: "The file is larger than 10 MB." };

  const res = await timedFetch(url, auth);
  if (!res.ok) return { ok: false, text: `Could not download the file (${res.status}).` };
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) return { ok: false, text: "The file is larger than 10 MB." };

  let text: string;
  if (exportAs) text = new TextDecoder().decode(buf);
  else {
    const name = /\.[a-z0-9]+$/i.test(meta.name) ? meta.name : meta.mimeType === "application/pdf" ? `${meta.name}.pdf` : `${meta.name}.txt`;
    const out = await extractFromBuffer(name, buf, MAX_DOWNLOAD);
    if (!out.ok) return { ok: false, text: out.reason };
    text = out.text;
  }
  const { chunk, header } = pageText(text, offset);
  return { ok: true, text: wrapUntrusted("connector_data", `${meta.name}\n${header}\n\n${chunk}`, 13000), summary: meta.name.slice(0, 40) };
}
