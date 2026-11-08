import "server-only";
import { wrapUntrusted } from "@/lib/security/url";
import { pageText, type ToolOutput } from "./page";
import { loadConnection, saveConnection } from "./store";

const API = "https://api.github.com";
const TIMEOUT = 15_000;

// Owner: GitHub login rules. Repo: allowed characters, but never "." or ".." (would let a request climb out of /repos/).
export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
export const REF_RE = /^[A-Za-z0-9_./-]{1,100}$/;

/** Rejects traversal and odd characters; returns the path URL-encoded segment by segment. */
export function safePath(path: unknown): string | null {
  if (path === undefined || path === "") return "";
  if (typeof path !== "string" || path.length > 300 || /[\u0000-\u001f\\]/.test(path)) return null;
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.some((p) => p === ".." || p === ".")) return null;
  return parts.map(encodeURIComponent).join("/");
}

export async function ghRequest(token: string, method: string, pathAndQuery: string, body?: unknown): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    return await fetch(`${API}${pathAndQuery}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "agent-hub",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}
const gh = (token: string, pathAndQuery: string) => ghRequest(token, "GET", pathAndQuery);

/** Validates a pasted token and stores it encrypted. Returns a warning when it can write to repositories. */
export async function connectGithub(userId: string, token: string, mode: "read" | "write" = "read"): Promise<{ ok: true; label: string; warning?: string } | { ok: false; error: string }> {
  if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) return { ok: false, error: "That does not look like a GitHub token." };
  const res = await gh(token, "/user").catch(() => null);
  if (!res || res.status === 401) return { ok: false, error: "GitHub rejected this token." };
  if (!res.ok) return { ok: false, error: "Could not reach GitHub. Try again." };
  const login = ((await res.json()) as { login?: string }).login ?? "unknown";
  const scopes = res.headers.get("x-oauth-scopes") ?? "";
  const risky = scopes.split(",").map((s) => s.trim()).filter((s) => ["repo", "admin:org", "delete_repo", "workflow", "write:packages"].includes(s));
  await saveConnection(userId, "github", { token, label: login, scopes: scopes || "fine-grained", mode });
  return {
    ok: true,
    label: login,
    warning:
      mode === "read" && risky.length
        ? `This token can change your repositories (${risky.join(", ")}). Replace it with a fine-grained read-only token.`
        : mode === "write" && risky.includes("repo")
          ? "This classic token can do far more than the agent needs. A fine-grained token limited to chosen repos is safer."
          : undefined,
  };
}

const NOT_CONNECTED: ToolOutput = { ok: false, text: "GitHub is not connected. Ask the user to connect it on the Connectors page." };

async function withToken(userId: string, fn: (token: string) => Promise<ToolOutput>): Promise<ToolOutput> {
  const c = await loadConnection(userId, "github");
  if (!c) return NOT_CONNECTED;
  const out = await fn(c.token).catch(() => ({ ok: false, text: "GitHub request failed." }) as ToolOutput);
  return out;
}

export const statusText = (r: Response) =>
  r.status === 401 ? "GitHub rejected the saved token. Ask the user to reconnect." : r.status === 404 ? "Not found, or the token cannot access it." : r.status === 403 ? "GitHub refused the request (permissions or rate limit)." : `GitHub error ${r.status}.`;

export function githubListRepos(userId: string): Promise<ToolOutput> {
  return withToken(userId, async (token) => {
    const r = await gh(token, "/user/repos?per_page=30&sort=pushed");
    if (!r.ok) return { ok: false, text: statusText(r) };
    const repos = (await r.json()) as { full_name: string; private: boolean; description: string | null; language: string | null; pushed_at: string }[];
    const body = repos.map((x) => `${x.full_name}${x.private ? " (private)" : ""} · ${x.language ?? "?"} · pushed ${x.pushed_at}\n${x.description ?? ""}`).join("\n\n");
    return { ok: true, text: wrapUntrusted("connector_data", body || "No repositories."), summary: `${repos.length} repos` };
  });
}

export function githubSearchCode(userId: string, query: unknown, repo: unknown): Promise<ToolOutput> {
  const q = typeof query === "string" ? query.trim().slice(0, 200) : "";
  if (!q) return Promise.resolve({ ok: false, text: "Missing query" });
  if (repo !== undefined && (typeof repo !== "string" || !REPO_RE.test(repo))) return Promise.resolve({ ok: false, text: "Invalid repo. Use owner/name." });
  return withToken(userId, async (token) => {
    const full = repo ? `${q} repo:${repo}` : q;
    const r = await gh(token, `/search/code?q=${encodeURIComponent(full)}&per_page=10`);
    if (!r.ok) return { ok: false, text: statusText(r) };
    const items = ((await r.json()) as { items?: { path: string; html_url: string; repository: { full_name: string } }[] }).items ?? [];
    const body = items.map((i, n) => `${n + 1}. ${i.repository.full_name}: ${i.path}\n${i.html_url}`).join("\n\n");
    return { ok: true, text: wrapUntrusted("connector_data", body || "No matches."), summary: `${items.length} matches` };
  });
}

export function githubReadFile(userId: string, repo: unknown, path: unknown, ref: unknown, offset: unknown): Promise<ToolOutput> {
  if (typeof repo !== "string" || !REPO_RE.test(repo)) return Promise.resolve({ ok: false, text: "Invalid repo. Use owner/name." });
  const p = safePath(path);
  if (p === null) return Promise.resolve({ ok: false, text: "Invalid path" });
  if (ref !== undefined && (typeof ref !== "string" || !REF_RE.test(ref))) return Promise.resolve({ ok: false, text: "Invalid ref" });
  return withToken(userId, async (token) => {
    const r = await gh(token, `/repos/${repo}/contents/${p}${ref ? `?ref=${encodeURIComponent(ref as string)}` : ""}`);
    if (!r.ok) return { ok: false, text: statusText(r) };
    const data = (await r.json()) as unknown;
    if (Array.isArray(data)) {
      const body = (data as { name: string; type: string; size: number }[]).slice(0, 200).map((e) => `${e.type === "dir" ? "[dir] " : ""}${e.name}${e.type === "file" ? ` (${e.size} bytes)` : ""}`).join("\n");
      return { ok: true, text: wrapUntrusted("connector_data", body), summary: "directory" };
    }
    const f = data as { type?: string; encoding?: string; content?: string; size?: number; name?: string };
    if (f.type !== "file" || f.encoding !== "base64" || typeof f.content !== "string") return { ok: false, text: "This item cannot be read as a text file (too large or not a file)." };
    const buf = Buffer.from(f.content, "base64");
    if (buf.includes(0)) return { ok: false, text: "This looks like a binary file." };
    const { chunk, header } = pageText(buf.toString("utf8"), offset);
    return { ok: true, text: wrapUntrusted("connector_data", `${repo}/${path ?? ""}\n${header}\n\n${chunk}`, 13000), summary: f.name?.slice(0, 40) };
  });
}

export function githubListIssues(userId: string, repo: unknown, state: unknown): Promise<ToolOutput> {
  if (typeof repo !== "string" || !REPO_RE.test(repo)) return Promise.resolve({ ok: false, text: "Invalid repo. Use owner/name." });
  const st = state === "closed" || state === "all" ? state : "open";
  return withToken(userId, async (token) => {
    const r = await gh(token, `/repos/${repo}/issues?state=${st}&per_page=15`);
    if (!r.ok) return { ok: false, text: statusText(r) };
    const items = (await r.json()) as { number: number; title: string; state: string; pull_request?: unknown; user?: { login: string } | null; html_url: string }[];
    const body = items.map((i) => `#${i.number} ${i.pull_request ? "[PR] " : ""}${i.title} (${i.state}, by ${i.user?.login ?? "?"})\n${i.html_url}`).join("\n\n");
    return { ok: true, text: wrapUntrusted("connector_data", body || "None."), summary: `${items.length} items` };
  });
}
