"use client";

import { useCallback, useEffect, useState } from "react";

type Tool = { name: string; description: string; readOnly: boolean; destructive: boolean; enabled: boolean };
type Server = {
  id: string;
  name: string;
  slug: string;
  host: string;
  authType: "none" | "bearer" | "oauth";
  policy: "ask_all" | "ask_unless_readonly";
  status: "active" | "needs_auth" | "needs_review" | "error";
  lastError: string | null;
  changedSinceReview: boolean;
  tools: Tool[];
};

const STATUS: Record<Server["status"], string> = { active: "Active", needs_review: "Review tools", needs_auth: "Sign-in needed", error: "Problem" };

export function McpApps({ onMessage }: { onMessage: (m: { text: string; good?: boolean }) => void }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", url: "", auth: "oauth" as Server["authType"], token: "", policy: "ask_unless_readonly" as Server["policy"] });
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});

  const load = useCallback(async () => {
    const r = await fetch("/api/mcp/servers", { cache: "no-store" });
    if (!r.ok) return;
    const list = ((await r.json()) as { servers: Server[] }).servers;
    setServers(list);
    setPicked((prev) => {
      const next = { ...prev };
      for (const s of list) if (!next[s.id]) next[s.id] = new Set(s.tools.filter((t) => (s.status === "active" ? t.enabled : true)).map((t) => t.name));
      return next;
    });
  }, []);
  useEffect(() => void load(), [load]);

  async function call(url: string, init?: RequestInit) {
    setBusy(true);
    try {
      const r = await fetch(url, init);
      const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
      return { ok: r.ok, status: r.status, j };
    } finally {
      setBusy(false);
    }
  }
  const msg = (j: Record<string, unknown> | null, fallback: string) => ((j?.error as { message?: string } | undefined)?.message ?? fallback);

  async function add() {
    const r = await call("/api/mcp/servers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.name, url: form.url, auth: form.auth, token: form.auth === "bearer" ? form.token : undefined, policy: form.policy }) });
    if (!r.ok) return onMessage({ text: msg(r.j, "Could not add the app.") });
    const s = (r.j?.server ?? null) as Server | null;
    setForm({ ...form, name: "", url: "", token: "" });
    if (s && r.j?.nextStep === "oauth") {
      window.location.href = `/api/mcp/oauth/start?server=${s.id}`;
      return;
    }
    onMessage(r.j?.discoveryError ? { text: `Added, but: ${String(r.j.discoveryError)}` } : { text: "App added. Review its tools below, then accept them.", good: true });
    void load();
  }
  async function refresh(id: string) {
    const r = await call(`/api/mcp/servers/${id}/refresh`, { method: "POST" });
    if (!r.ok && r.status === 401) window.location.href = `/api/mcp/oauth/start?server=${id}`;
    else onMessage(r.ok ? { text: "Tool list updated.", good: true } : { text: msg(r.j, "Could not refresh.") });
    void load();
  }
  async function accept(s: Server) {
    const r = await call(`/api/mcp/servers/${s.id}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabledTools: [...(picked[s.id] ?? [])] }) });
    onMessage(r.ok ? { text: `${s.name} is active with ${(picked[s.id] ?? new Set()).size} tools.`, good: true } : { text: msg(r.j, "Could not save.") });
    void load();
  }
  async function policy(s: Server, p: Server["policy"]) {
    await call(`/api/mcp/servers/${s.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy: p }) });
    void load();
  }
  async function remove(s: Server) {
    await call(`/api/mcp/servers/${s.id}`, { method: "DELETE" });
    onMessage({ text: `${s.name} removed.`, good: true });
    void load();
  }
  const toggle = (sid: string, tool: string) =>
    setPicked((p) => {
      const set = new Set(p[sid] ?? []);
      if (set.has(tool)) set.delete(tool);
      else set.add(tool);
      return { ...p, [sid]: set };
    });

  return (
    <section className="conn-card">
      <div className="conn-row">
        <h2>Apps (MCP)</h2>
        <span className="status">{servers.filter((s) => s.status === "active").length} active</span>
      </div>
      <p className="muted">Connect any remote MCP server (Linear, Notion, Sentry, your own…). The agent can use several apps at once. You review each app&apos;s tools before it can use them, and anything that is not marked read-only waits for your approval.</p>

      {servers.map((s) => (
        <div key={s.id} className="mcp-app">
          <div className="conn-row">
            <strong>{s.name}</strong>
            <span className={`status ${s.status === "active" ? "on" : ""}`}>{STATUS[s.status]} · {s.host}</span>
          </div>
          {s.changedSinceReview && <div className="notice">This app changed its tools since you accepted them. It is paused until you review the new list.</div>}
          {s.lastError && s.status !== "active" && <p className="muted">{s.lastError}</p>}
          {s.status === "needs_auth" && <a className="btn primary" href={`/api/mcp/oauth/start?server=${s.id}`} style={{ textDecoration: "none", textAlign: "center" }}>Sign in to {s.name}</a>}
          {s.tools.length > 0 && (
            <ul className="mcp-tools">
              {s.tools.map((t) => (
                <li key={t.name}>
                  <label>
                    <input type="checkbox" checked={picked[s.id]?.has(t.name) ?? false} onChange={() => toggle(s.id, t.name)} />
                    <span>
                      <code>{t.name}</code> <em>{t.readOnly ? "read-only" : t.destructive ? "can change or delete" : "can change things"}</em>
                      <small>{t.description}</small>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="seg-row">
            {s.tools.length > 0 && <button className="btn primary" disabled={busy} onClick={() => void accept(s)}>{s.status === "active" ? "Save tool choices" : "Accept these tools"}</button>}
            <button className="btn" disabled={busy} onClick={() => void refresh(s.id)}>Refresh tools</button>
            <select aria-label="Approval policy" value={s.policy} onChange={(e) => void policy(s, e.target.value as Server["policy"])}>
              <option value="ask_unless_readonly">Ask unless read-only</option>
              <option value="ask_all">Ask for every call</option>
            </select>
            <button className="btn" disabled={busy} onClick={() => void remove(s)}>Remove</button>
          </div>
        </div>
      ))}

      <div className="mcp-add">
        <h3>Add an app</h3>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name, e.g. Linear" aria-label="App name" maxLength={60} />
        <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://mcp.example.com/mcp" aria-label="Server address" inputMode="url" />
        <div className="seg-row" role="group" aria-label="Sign-in method">
          {(["oauth", "bearer", "none"] as const).map((a) => (
            <button key={a} className={`seg ${form.auth === a ? "on" : ""}`} onClick={() => setForm({ ...form, auth: a })}>{a === "oauth" ? "Sign in (OAuth)" : a === "bearer" ? "Access token" : "No sign-in"}</button>
          ))}
        </div>
        {form.auth === "bearer" && <input type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder="Access token or API key" autoComplete="off" aria-label="Access token" />}
        <button className="btn primary" disabled={busy || !form.name.trim() || form.url.trim().length < 8 || (form.auth === "bearer" && !form.token.trim())} onClick={() => void add()}>{busy ? "Connecting…" : "Add app"}</button>
        <p className="muted">Only public https servers are allowed. Servers that run on your own computer (stdio) cannot be reached from the cloud.</p>
      </div>
    </section>
  );
}
