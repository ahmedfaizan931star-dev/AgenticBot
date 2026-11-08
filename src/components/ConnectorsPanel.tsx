"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { McpApps } from "./McpApps";

type Mode = "read" | "write";
type Status = {
  google: { configured: boolean; connected: boolean; label: string | null; mode: Mode | null };
  github: { connected: boolean; label: string | null; mode: Mode | null };
  grounding: boolean;
};
type AuditEvent = { id: number; event: string; detail: Record<string, unknown>; created_at: string };

const MESSAGES: Record<string, { text: string; good?: boolean }> = {
  "connected=google": { text: "Google Drive is connected.", good: true },
  "error=google_denied": { text: "Google access was not granted." },
  "error=google_state": { text: "The sign-in link expired. Try connecting again." },
  "error=google_failed": { text: "Google did not complete the connection. Make sure the Drive permission was ticked." },
  "error=google_not_configured": { text: "Google Drive is not set up on this server yet." },
  "mcp=connected": { text: "App connected. Review its tools below and accept them.", good: true },
  "mcp=denied": { text: "Sign-in was cancelled." },
};

const EVENT_LABEL: Record<string, string> = {
  connector_connected: "Connected",
  connector_disconnected: "Disconnected",
  action_proposed: "Action proposed",
  action_done: "Action approved and done",
  action_failed: "Action approved but failed",
  action_denied: "Action denied",
  action_expired: "Action expired",
  mcp_connected: "App added",
  mcp_removed: "App removed",
  mcp_reviewed: "App tools accepted",
  mcp_signed_in: "App signed in",
  mcp_policy_changed: "App policy changed",
};

function describe(e: AuditEvent): string {
  const d = e.detail;
  const parts = [typeof d.provider === "string" ? d.provider : "", typeof d.name === "string" ? d.name : "", typeof d.mode === "string" ? `(${d.mode})` : "", typeof d.summary === "string" ? d.summary : "", typeof d.tool === "string" && !d.summary ? d.tool : ""];
  return parts.filter(Boolean).join(" ");
}

function Panel() {
  const params = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [token, setToken] = useState("");
  const [ghMode, setGhMode] = useState<Mode>("read");
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = params.get("connected") ? `connected=${params.get("connected")}` : params.get("mcp") ? `mcp=${params.get("mcp")}` : params.get("error") ? `error=${params.get("error")}` : "";
  const [message, setMessage] = useState<{ text: string; good?: boolean } | null>(MESSAGES[key] ?? (params.get("mcp") === "error" ? { text: params.get("reason") ?? "Could not connect the app." } : null));

  const load = useCallback(async () => {
    const [s, a] = await Promise.all([fetch("/api/connectors", { cache: "no-store" }), fetch("/api/activity", { cache: "no-store" })]);
    if (s.ok) setStatus((await s.json()) as Status);
    if (a.ok) setEvents(((await a.json()) as { events: AuditEvent[] }).events);
  }, []);
  useEffect(() => void load(), [load]);

  async function connectGithub() {
    setBusy(true);
    setMessage(null);
    const r = await fetch("/api/connectors/github", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, mode: ghMode }) });
    const j = (await r.json().catch(() => null)) as { label?: string; warning?: string | null; error?: { message?: string } } | null;
    if (r.ok) {
      setToken("");
      setReplace(false);
      setMessage({ text: j?.warning ? `Connected as ${j.label}. ${j.warning}` : `GitHub is connected as ${j?.label}.`, good: !j?.warning });
    } else setMessage({ text: j?.error?.message ?? "Could not connect." });
    setBusy(false);
    void load();
  }
  async function disconnect(provider: "google" | "github") {
    setBusy(true);
    await fetch(`/api/connectors/${provider}`, { method: "DELETE" });
    setMessage({ text: provider === "github" ? "GitHub disconnected. Also delete the token in GitHub settings." : "Google Drive disconnected and access revoked.", good: true });
    setBusy(false);
    void load();
  }

  const g = status?.google;
  const gh = status?.github;
  const modeText = (m: Mode | null) => (m === "write" ? "read and write (with your approval)" : "read-only");

  return (
    <main className="connectors">
      <header>
        <h1>Connectors</h1>
        <Link className="btn" href="/chat">Back to chat</Link>
      </header>
      <p className="muted">Reading is automatic. Anything that changes something (an issue, a commit, a new Doc) is only ever a proposal: you see the exact content and press Approve first. Nothing is merged, deleted or overwritten.</p>
      {message && <div className={`notice ${message.good ? "good" : ""}`} role="status">{message.text}</div>}

      <section className="conn-card">
        <div className="conn-row">
          <h2>Google Drive</h2>
          <span className={`status ${g?.connected ? "on" : ""}`}>{g?.connected ? `Connected · ${modeText(g.mode)}${g.label ? ` · ${g.label}` : ""}` : "Not connected"}</span>
        </div>
        <p className="muted">Read: search and open your Docs, Sheets, Slides, PDFs and text files. Write: create new Google Docs only. Existing files are never edited.</p>
        {!g?.connected ? (
          <div className="seg-row">
            <a className="btn primary" href="/api/connectors/google/start" style={{ textDecoration: "none" }}>Connect read-only</a>
            <a className="btn" href="/api/connectors/google/start?mode=write" style={{ textDecoration: "none" }}>Connect read + create Docs</a>
          </div>
        ) : (
          <div className="seg-row">
            {g.mode !== "write" && <a className="btn" href="/api/connectors/google/start?mode=write" style={{ textDecoration: "none" }}>Allow creating Docs</a>}
            <button className="btn" disabled={busy} onClick={() => void disconnect("google")}>Disconnect</button>
          </div>
        )}
        {g && !g.configured && <p className="muted">The server owner still needs to add Google credentials.</p>}
      </section>

      <section className="conn-card">
        <div className="conn-row">
          <h2>GitHub</h2>
          <span className={`status ${gh?.connected ? "on" : ""}`}>{gh?.connected ? `Connected · ${modeText(gh.mode)}${gh.label ? ` · ${gh.label}` : ""}` : "Not connected"}</span>
        </div>
        <p className="muted">Read: code, files, issues. Write: issues, comments, and files on new <code>agent/…</code> branches plus pull requests. Never the default branch, never merges or deletes, never <code>.github/</code>.</p>
        {gh?.connected && !replace ? (
          <div className="seg-row">
            <button className="btn" onClick={() => setReplace(true)}>Replace token / change access</button>
            <button className="btn" disabled={busy} onClick={() => void disconnect("github")}>Disconnect</button>
          </div>
        ) : (
          <>
            <div className="seg-row" role="group" aria-label="GitHub access">
              <button className={`seg ${ghMode === "read" ? "on" : ""}`} onClick={() => setGhMode("read")}>Read-only</button>
              <button className={`seg ${ghMode === "write" ? "on" : ""}`} onClick={() => setGhMode("write")}>Read + write with approval</button>
            </div>
            <p className="muted">
              Fine-grained token, chosen repos only. Read-only: Contents, Issues, Pull requests = Read. For write access set the same three to Read and write.
            </p>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" autoComplete="off" aria-label="GitHub token" />
            <button className="btn primary" disabled={busy || token.trim().length < 20} onClick={() => void connectGithub()}>Connect GitHub</button>
          </>
        )}
      </section>

      <McpApps onMessage={setMessage} />

      <section className="conn-card">
        <div className="conn-row">
          <h2>Google search</h2>
          <span className={`status ${status?.grounding ? "on" : ""}`}>{status?.grounding ? "Enabled" : "Off on this server"}</span>
        </div>
        <p className="muted">Fresh Google results through Gemini grounding, with Google&apos;s search suggestions shown under the answer. Daily limits apply.</p>
      </section>

      <section className="conn-card activity">
        <h2>Activity</h2>
        {events.length === 0 ? <p className="muted">Nothing yet. Connections and every proposed or approved action show up here.</p> : (
          <ul>
            {events.map((e) => (
              <li key={e.id}>
                <span>{EVENT_LABEL[e.event] ?? e.event} {describe(e)}</span>
                <time dateTime={e.created_at}>{new Date(e.created_at).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

export function ConnectorsPanel() {
  return (
    <Suspense>
      <Panel />
    </Suspense>
  );
}
