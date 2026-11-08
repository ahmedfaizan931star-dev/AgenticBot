import "server-only";
import { markdownToHtml } from "@/lib/actions/markdown";
import { safePath, ghRequest, statusText } from "./github";
import { accessToken } from "./google";
import type { ToolOutput } from "./page";
import { loadConnection } from "./store";

const need = (what: string): ToolOutput => ({ ok: false, text: `${what} write access is not enabled. Ask the user to enable it on the Connectors page.` });

type Json = Record<string, unknown>;
const j = async (r: Response) => ((await r.json().catch(() => ({}))) as Json) ?? {};

/** Runs an already-approved GitHub write. Arguments were validated when the action was proposed and are re-checked by the caller. */
export async function githubWrite(userId: string, tool: string, a: Json): Promise<ToolOutput> {
  const c = await loadConnection(userId, "github");
  if (!c) return { ok: false, text: "GitHub is not connected." };
  if (c.mode !== "write") return need("GitHub");
  const t = c.token;
  const repo = String(a.repo);

  if (tool === "github_create_issue") {
    const r = await ghRequest(t, "POST", `/repos/${repo}/issues`, { title: a.title, body: a.body ?? "", ...(a.labels ? { labels: a.labels } : {}) });
    if (!r.ok) return { ok: false, text: statusText(r) };
    const d = await j(r);
    return { ok: true, text: `Issue created: ${String(d.html_url)}`, summary: `Issue #${String(d.number)}` };
  }
  if (tool === "github_comment") {
    const r = await ghRequest(t, "POST", `/repos/${repo}/issues/${Number(a.number)}/comments`, { body: a.body });
    if (!r.ok) return { ok: false, text: statusText(r) };
    return { ok: true, text: `Comment posted: ${String((await j(r)).html_url)}`, summary: "Comment posted" };
  }
  if (tool === "github_open_pr") {
    const info = await ghRequest(t, "GET", `/repos/${repo}`);
    if (!info.ok) return { ok: false, text: statusText(info) };
    const base = typeof a.base === "string" ? a.base : String((await j(info)).default_branch ?? "main");
    if (base === a.head) return { ok: false, text: "Head and base are the same branch." };
    const r = await ghRequest(t, "POST", `/repos/${repo}/pulls`, { title: a.title, head: a.head, base, body: a.body ?? "" });
    if (!r.ok) return { ok: false, text: r.status === 422 ? "GitHub refused the pull request (no changes between the branches, or one already exists)." : statusText(r) };
    return { ok: true, text: `Pull request opened: ${String((await j(r)).html_url)}`, summary: "PR opened" };
  }
  if (tool === "github_commit_file") {
    const path = safePath(a.path);
    const branch = String(a.branch);
    if (!path) return { ok: false, text: "Invalid path" };
    const info = await ghRequest(t, "GET", `/repos/${repo}`);
    if (!info.ok) return { ok: false, text: statusText(info) };
    const def = String((await j(info)).default_branch ?? "");
    if (!def || branch === def) return { ok: false, text: "Refusing to write to the default branch." };

    // Create the agent branch from the default branch if it does not exist yet.
    const ref = await ghRequest(t, "GET", `/repos/${repo}/git/ref/heads/${branch}`);
    if (ref.status === 404) {
      const base = await ghRequest(t, "GET", `/repos/${repo}/git/ref/heads/${def}`);
      if (!base.ok) return { ok: false, text: statusText(base) };
      const sha = String(((await j(base)).object as Json | undefined)?.sha ?? "");
      const created = await ghRequest(t, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
      if (!created.ok) return { ok: false, text: statusText(created) };
    } else if (!ref.ok) return { ok: false, text: statusText(ref) };

    const existing = await ghRequest(t, "GET", `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
    let sha: string | undefined;
    if (existing.ok) {
      const d = await j(existing);
      if (Array.isArray(d)) return { ok: false, text: "That path is a directory." };
      sha = typeof d.sha === "string" ? d.sha : undefined;
    } else if (existing.status !== 404) return { ok: false, text: statusText(existing) };

    const put = await ghRequest(t, "PUT", `/repos/${repo}/contents/${path}`, {
      message: a.message,
      content: Buffer.from(String(a.content), "utf8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    });
    if (!put.ok) return { ok: false, text: statusText(put) };
    const commit = ((await j(put)).commit as Json | undefined) ?? {};
    return { ok: true, text: `Committed to branch ${branch}: ${String(commit.html_url ?? "")}. Open a pull request to propose it.`, summary: `Committed to ${branch}` };
  }
  return { ok: false, text: "Unknown GitHub action" };
}

export async function driveWrite(userId: string, tool: string, a: Json): Promise<ToolOutput> {
  if (tool !== "drive_create_doc") return { ok: false, text: "Unknown Drive action" };
  const c = await loadConnection(userId, "google");
  if (!c) return { ok: false, text: "Google Drive is not connected." };
  if (c.mode !== "write") return need("Google Drive");
  const token = await accessToken(userId);
  if (!token) return { ok: false, text: "Google Drive access expired. Ask the user to reconnect." };

  const boundary = `b${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const meta = JSON.stringify({ name: a.title, mimeType: "application/vnd.google-apps.document" });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${markdownToHtml(String(a.content))}\r\n--${boundary}--`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, text: `Google Drive refused the new document (${res.status}).` };
    const d = (await res.json()) as { name?: string; webViewLink?: string };
    return { ok: true, text: `Google Doc created: ${d.name ?? ""} ${d.webViewLink ?? ""}`.trim(), summary: "Doc created" };
  } finally {
    clearTimeout(timer);
  }
}
