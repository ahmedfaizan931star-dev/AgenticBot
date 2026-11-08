"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionCard, BrowserCall, PlanStep, StreamEvent } from "@/lib/agent/events";
import { pingExtension, runBrowserTool, type ExtensionStatus } from "@/lib/bridge";
import { Markdown } from "./Markdown";

type ToolChip = { id: string; name: string; state: "running" | "waiting" | "done" | "error"; summary?: string };
type Approval = ActionCard & { state: "pending" | "working" | "done" | "failed" | "denied" | "expired"; result?: string };
type UiMessage = { key: string; role: "user" | "assistant"; text: string; tools: ToolChip[]; approvals: Approval[]; plan?: PlanStep[]; suggestions: string[] };
type DbAction = { id: string; tool_call_id: string; tool: string; summary: string; preview: string | null; status: string; result: string | null };
type ChatRow = { id: string; title: string; updated_at: string };
type DbMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls: { id: string; function: { name: string; arguments?: string } }[] | null;
  tool_call_id: string | null;
  is_error: boolean;
  meta?: { suggestionsHtml?: string } | null;
};

const LAST_CHAT_KEY = "agent-hub:last-chat";
const TOOL_LABEL: Record<string, string> = {
  web_search: "Web search",
  remember: "Save note",
  recall: "Look up notes",
  browser_list_tabs: "List tabs",
  browser_read_tab: "Read tab",
  browser_open_tab: "Open tab",
  browser_navigate: "Go to address",
  browser_click: "Click",
  browser_type: "Type",
  drive_search: "Search Drive",
  drive_read: "Read Drive file",
  github_list_repos: "List repos",
  github_search_code: "Search code",
  github_read_file: "Read repo file",
  github_list_issues: "List issues",
  read_upload: "Read file",
  deep_research: "Deep research",
  google_search: "Google search",
  read_webpage: "Read page",
  update_plan: "Plan",
  github_create_issue: "Propose issue",
  github_comment: "Propose comment",
  github_commit_file: "Propose commit",
  github_open_pr: "Propose pull request",
  drive_create_doc: "Propose new Doc",
  mcp_call: "App action",
};
const toolLabel = (name: string) => {
  const m = name.match(/^mcp_([a-z0-9_]+?)__(.+)$/);
  return m ? `${m[2]} · ${m[1]}` : (TOOL_LABEL[name] ?? name);
};
type Mode = "chat" | "research" | "deep";
type Attachment = { id: string; name: string; chars: number };

const ACTION_STATE: Record<string, Approval["state"]> = { pending: "pending", executing: "working", done: "done", failed: "failed", denied: "denied", expired: "expired" };

function fromDb(rows: DbMessage[], actions: DbAction[] = []): UiMessage[] {
  const out: UiMessage[] = [];
  const blank = (key: string, role: "user" | "assistant", text: string): UiMessage => ({ key, role, text, tools: [], approvals: [], suggestions: [] });
  for (const r of rows) {
    if (r.role === "user") out.push(blank(r.id, "user", r.content ?? ""));
    else if (r.role === "assistant") {
      const tools = (r.tool_calls ?? []).filter((c) => c.function.name !== "update_plan").map((c) => ({ id: c.id, name: c.function.name, state: "done" as const }));
      let plan: PlanStep[] | undefined;
      for (const c of r.tool_calls ?? []) {
        if (c.function.name === "update_plan") {
          try {
            plan = (JSON.parse(c.function.arguments ?? "{}") as { steps?: PlanStep[] }).steps;
          } catch {
            // ignore a malformed plan
          }
        }
      }
      let m = out[out.length - 1];
      if (m && m.role === "assistant") m.text = [m.text, r.content ?? ""].filter(Boolean).join("\n\n");
      else {
        m = blank(r.id, "assistant", r.content ?? "");
        out.push(m);
      }
      m.tools.push(...tools);
      if (plan) m.plan = plan;
    } else {
      for (let j = out.length - 1; j >= 0; j--) {
        const m = out[j]!;
        const t = m.tools.find((x) => x.id === r.tool_call_id);
        if (t) {
          if (r.is_error) t.state = "error";
          if (r.meta?.suggestionsHtml) m.suggestions.push(r.meta.suggestionsHtml);
          const a = actions.find((x) => x.tool_call_id === r.tool_call_id);
          if (a) m.approvals.push({ id: a.id, tool: a.tool, summary: a.summary, preview: a.preview, state: ACTION_STATE[a.status] ?? "failed", result: a.result ?? undefined });
          break;
        }
      }
    }
  }
  return out;
}

export function ChatApp({ initialChatId, email, startFresh }: { initialChatId?: string; email: string; startFresh?: boolean }) {
  const router = useRouter();
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [chatId, setChatIdState] = useState<string | undefined>(initialChatId);
  const chatRef = useRef<string | undefined>(initialChatId);
  const setChatId = (id: string | undefined) => {
    chatRef.current = id;
    setChatIdState(id);
  };
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("chat");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [canContinue, setCanContinue] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  const [ext, setExt] = useState<ExtensionStatus>({ connected: false });
  const [notice, setNotice] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<UiMessage[]>([]);
  const extRef = useRef(ext);
  extRef.current = ext;
  messagesRef.current = messages;

  const refreshChats = useCallback(async () => {
    const r = await fetch("/api/chats", { cache: "no-store" });
    if (r.ok) setChats(((await r.json()) as { chats: ChatRow[] }).chats);
  }, []);
  const refreshCredits = useCallback(async () => {
    const r = await fetch("/api/credits", { cache: "no-store" });
    if (r.ok) setCredits(((await r.json()) as { balance: number }).balance);
  }, []);
  const refreshExt = useCallback(async () => setExt(await pingExtension()), []);

  const loadChat = useCallback(async (id: string) => {
    const r = await fetch(`/api/chats/${id}`, { cache: "no-store" });
    if (!r.ok) {
      localStorage.removeItem(LAST_CHAT_KEY);
      setChatId(undefined);
      setMessages([]);
      return;
    }
    const data = (await r.json()) as { messages: DbMessage[]; activeJob: { id: string } | null; actions: DbAction[] };
    setMessages(fromDb(data.messages, data.actions));
    if (data.activeJob) void resumeDeep(data.activeJob.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore the previous session on first load.
  useEffect(() => {
    void refreshChats();
    void refreshCredits();
    void refreshExt();
    const id = initialChatId ?? (startFresh ? undefined : (localStorage.getItem(LAST_CHAT_KEY) ?? undefined));
    if (id && !initialChatId) router.replace(`/chat/${id}`);
    if (id) void loadChat(id);
    const onFocus = () => void refreshExt();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [initialChatId, startFresh, loadChat, refreshChats, refreshCredits, refreshExt, router]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const patchAssistant = (fn: (m: UiMessage) => void) =>
    setMessages((prev) => {
      const copy = prev.map((m) => ({ ...m, tools: m.tools.map((t) => ({ ...t })), approvals: m.approvals.map((a) => ({ ...a })), suggestions: [...m.suggestions] }));
      const last = copy[copy.length - 1];
      if (last && last.role === "assistant") fn(last);
      return copy;
    });

  async function stream(body: Record<string, unknown>): Promise<BrowserCall[] | null> {
    const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok || !res.body) {
      const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setNotice(j?.error?.message ?? "Request failed.");
      return null;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let browser: BrowserCall[] | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: StreamEvent;
        try {
          ev = JSON.parse(line) as StreamEvent;
        } catch {
          continue;
        }
        if (ev.type === "chat") {
          setChatId(ev.chatId);
          localStorage.setItem(LAST_CHAT_KEY, ev.chatId);
          window.history.replaceState(null, "", `/chat/${ev.chatId}`);
        } else if (ev.type === "text") patchAssistant((m) => (m.text += ev.delta));
        else if (ev.type === "tool_status") {
          patchAssistant((m) => {
            const t = m.tools.find((x) => x.id === ev.id);
            if (t) {
              t.state = ev.state;
              t.summary = ev.summary;
            } else m.tools.push({ id: ev.id, name: ev.name, state: ev.state, summary: ev.summary });
          });
        } else if (ev.type === "browser_tool_calls") {
          browser = ev.calls;
          patchAssistant((m) => {
            for (const c of ev.calls) if (!m.tools.some((t) => t.id === c.id)) m.tools.push({ id: c.id, name: c.name, state: "waiting" });
          });
        } else if (ev.type === "credits") setCredits(ev.balance);
        else if (ev.type === "approval_required") patchAssistant((m) => m.approvals.push({ ...ev.action, state: "pending" }));
        else if (ev.type === "plan") patchAssistant((m) => (m.plan = ev.steps));
        else if (ev.type === "suggestions") patchAssistant((m) => m.suggestions.push(ev.html));
        else if (ev.type === "error") {
          if (ev.code === "step_limit") setCanContinue(true);
          setNotice(ev.code === "insufficient_credits" ? "You are out of credits." : ev.message);
        }
      }
    }
    return browser;
  }

  async function uploadFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setUploading(true);
    setNotice(null);
    for (const file of Array.from(list).slice(0, 5 - attachments.length)) {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/uploads", { method: "POST", body: fd });
      const j = (await r.json().catch(() => null)) as (Attachment & { error?: { message?: string } }) | null;
      if (r.ok && j && j.id) setAttachments((a) => [...a, { id: j.id, name: j.name, chars: j.chars }]);
      else setNotice(`${file.name}: ${j?.error?.message ?? "upload failed"}`);
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }
  async function removeAttachment(id: string) {
    setAttachments((a) => a.filter((x) => x.id !== id));
    await fetch(`/api/uploads/${id}`, { method: "DELETE" });
  }

  const setDeepChip = (state: ToolChip["state"], summary?: string) =>
    patchAssistant((m) => {
      const t = m.tools.find((x) => x.id === "deep");
      if (t) {
        t.state = state;
        t.summary = summary;
      } else m.tools.push({ id: "deep", name: "deep_research", state, summary });
    });

  /** Drives a deep-research job one small step at a time; safe to call again after a reload. */
  async function runDeep(jobId: string) {
    setBusy(true);
    let busyRetries = 0;
    try {
      for (let step = 0; step < 14; step++) {
        const res = await fetch(`/api/research/${jobId}/step`, { method: "POST" });
        if (!res.ok || !res.body) {
          setNotice("Could not continue the research. Reopen the chat to resume.");
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let phase: string | null = null;
        let errorCode: string | null = null;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev: StreamEvent;
            try {
              ev = JSON.parse(line) as StreamEvent;
            } catch {
              continue;
            }
            if (ev.type === "research_progress") {
              phase = ev.phase;
              setDeepChip(ev.phase === "done" ? "done" : ev.phase === "failed" ? "error" : "running", ev.detail);
            } else if (ev.type === "text") patchAssistant((m) => (m.text += ev.delta));
            else if (ev.type === "error") {
              errorCode = ev.code;
              if (ev.code !== "busy") setNotice(ev.message);
            }
          }
        }
        if (phase === "done" || phase === "failed") break;
        if (errorCode === "busy") {
          if (++busyRetries > 5) return;
          await new Promise((r) => setTimeout(r, 4000));
        } else if (errorCode) {
          setDeepChip("error", "tap Send again or reopen to retry");
          return;
        }
      }
    } finally {
      setBusy(false);
      void refreshChats();
      void refreshCredits();
      if (chatRef.current) void loadChatQuiet(chatRef.current);
    }
  }
  const resumeDeep = async (jobId: string) => {
    setMessages((m) => (m.length && m[m.length - 1]!.role === "assistant" ? m : [...m, { key: crypto.randomUUID(), role: "assistant", text: "", tools: [], approvals: [], suggestions: [] }]));
    setDeepChip("running", "resuming");
    await runDeep(jobId);
  };
  async function loadChatQuiet(id: string) {
    const r = await fetch(`/api/chats/${id}`, { cache: "no-store" });
    if (r.ok) {
      const d = (await r.json()) as { messages: DbMessage[]; actions: DbAction[] };
      setMessages(fromDb(d.messages, d.actions));
    }
  }

  async function startDeep(text: string) {
    setMessages((m) => [...m, { key: crypto.randomUUID(), role: "user", text, tools: [], approvals: [], suggestions: [] }, { key: crypto.randomUUID(), role: "assistant", text: "", tools: [{ id: "deep", name: "deep_research", state: "running", summary: "starting" }], approvals: [], suggestions: [] }]);
    const r = await fetch("/api/research", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: chatRef.current, content: text }) });
    const j = (await r.json().catch(() => null)) as { jobId?: string; chatId?: string; error?: { message?: string } } | null;
    if (!r.ok || !j?.jobId || !j.chatId) {
      setNotice(j?.error?.message ?? "Could not start deep research.");
      setDeepChip("error", "not started");
      setBusy(false);
      return;
    }
    setChatId(j.chatId);
    localStorage.setItem(LAST_CHAT_KEY, j.chatId);
    window.history.replaceState(null, "", `/chat/${j.chatId}`);
    void refreshCredits();
    await runDeep(j.jobId);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setNotice(null);
    setBusy(true);
    if (mode === "deep") {
      await startDeep(text);
      return;
    }
    const files = attachments;
    setAttachments([]);
    setMessages((m) => [...m, { key: crypto.randomUUID(), role: "user", text: files.length ? `${text}\n\n[Attached: ${files.map((f) => f.name).join(", ")}]` : text, tools: [], approvals: [], suggestions: [] }, { key: crypto.randomUUID(), role: "assistant", text: "", tools: [], approvals: [], suggestions: [] }]);
    try {
      let pending = await stream({ kind: "user", chatId: chatRef.current, content: text, attachments: files.map((f) => f.id), mode, extension: extRef.current.connected });
      for (let round = 0; pending && round < 10; round++) {
        const results: { toolCallId: string; content: string; isError: boolean }[] = [];
        for (const call of pending) {
          patchAssistant((m) => {
            const t = m.tools.find((x) => x.id === call.id);
            if (t) t.state = "waiting";
          });
          const r = await runBrowserTool(call.name, call.args);
          const content = r.ok ? JSON.stringify(r.result) : r.error;
          results.push({ toolCallId: call.id, content, isError: !r.ok });
          patchAssistant((m) => {
            const t = m.tools.find((x) => x.id === call.id);
            if (t) t.state = r.ok ? "done" : "error";
          });
        }
        const id = chatRef.current;
        if (!id) break;
        pending = await stream({ kind: "tool_results", chatId: id, results, mode, extension: extRef.current.connected });
      }
    } catch {
      setNotice("Connection lost. Your chat is saved; send again to continue.");
    } finally {
      setBusy(false);
      void refreshChats();
      void refreshCredits();
    }
  }

  /** Runs the agent again after approvals were decided, or after the step limit. */
  async function continueRun() {
    if (!chatRef.current || busy) return;
    setBusy(true);
    setNotice(null);
    setCanContinue(false);
    setMessages((m) => [...m, { key: crypto.randomUUID(), role: "assistant", text: "", tools: [], approvals: [], suggestions: [] }]);
    try {
      let pending = await stream({ kind: "continue", chatId: chatRef.current, mode: mode === "deep" ? "chat" : mode, extension: extRef.current.connected });
      for (let round = 0; pending && round < 10; round++) {
        const results: { toolCallId: string; content: string; isError: boolean }[] = [];
        for (const call of pending) {
          const r = await runBrowserTool(call.name, call.args);
          results.push({ toolCallId: call.id, content: r.ok ? JSON.stringify(r.result) : r.error, isError: !r.ok });
        }
        pending = await stream({ kind: "tool_results", chatId: chatRef.current!, results, mode: mode === "deep" ? "chat" : mode, extension: extRef.current.connected });
      }
    } catch {
      setNotice("Connection lost. Your chat is saved.");
    } finally {
      setBusy(false);
      void refreshChats();
      void refreshCredits();
    }
  }

  async function decide(messageKey: string, actionId: string, decision: "approve" | "deny") {
    const setState = (state: Approval["state"], result?: string) =>
      setMessages((prev) => prev.map((m) => (m.key === messageKey ? { ...m, approvals: m.approvals.map((a) => (a.id === actionId ? { ...a, state, result } : a)) } : m)));
    setState("working");
    const r = await fetch(`/api/actions/${actionId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) });
    const j = (await r.json().catch(() => null)) as { status?: string; result?: string; error?: { message?: string; code?: string } } | null;
    if (!r.ok) {
      setState(j?.error?.code === "expired" ? "expired" : "failed", j?.error?.message);
      return;
    }
    setState((j?.status as Approval["state"]) ?? "done", j?.result);
    // Once every card in this message is decided, let the agent carry on.
    const stillPending = messagesRef.current.some((m) => m.key === messageKey && m.approvals.some((a) => a.id !== actionId && (a.state === "pending" || a.state === "working")));
    if (!stillPending) void continueRun();
  }

  function newChat() {
    localStorage.removeItem(LAST_CHAT_KEY);
    setChatId(undefined);
    setMessages([]);
    setDrawer(false);
    window.history.replaceState(null, "", "/chat/new");
    router.replace("/chat/new");
  }
  async function removeChat(id: string) {
    await fetch(`/api/chats/${id}`, { method: "DELETE" });
    if (id === chatId) newChat();
    void refreshChats();
  }
  function open(id: string) {
    setDrawer(false);
    localStorage.setItem(LAST_CHAT_KEY, id);
    setChatId(id);
    window.history.replaceState(null, "", `/chat/${id}`);
    void loadChat(id);
  }

  const extLabel = !ext.connected
    ? "Extension not found"
    : !ext.enabled
      ? "Extension off"
      : !ext.tabAccess
        ? "Needs tab access"
        : "Browser connected";

  return (
    <div className="shell">
      <aside className={`side ${drawer ? "open" : ""}`}>
        <div className="brand">Agent Hub</div>
        <button className="btn primary" onClick={newChat}>New chat</button>
        <Link className="btn" href="/connectors">Connectors</Link>
        <nav className="chats" aria-label="Chats">
          {chats.length === 0 && <p className="muted">Your chats will appear here.</p>}
          {chats.map((c) => (
            <div key={c.id} className={`chat-item ${c.id === chatId ? "active" : ""}`}>
              <button className="chat-open" onClick={() => open(c.id)}>{c.title}</button>
              <button className="chat-del" aria-label={`Delete ${c.title}`} onClick={() => void removeChat(c.id)}>Delete</button>
            </div>
          ))}
        </nav>
        <div className="account">
          <span className="muted">{email}</span>
          <form action="/auth/signout" method="post"><button className="btn">Sign out</button></form>
        </div>
      </aside>

      <main className="main">
        <header className="top">
          <button className="btn menu" onClick={() => setDrawer((d) => !d)} aria-label="Chats">Chats</button>
          <div className={`pill ${ext.connected && ext.enabled && ext.tabAccess ? "ok" : ""}`} title="Browser extension status">{extLabel}</div>
          <div className="pill credits" aria-live="polite">{credits === null ? "…" : `${credits} credits`}</div>
        </header>

        <section className="thread" aria-live="polite">
          {messages.length === 0 && (
            <div className="empty">
              <h1>What should we work on?</h1>
              <p>Ask anything, research a topic with sources{ext.connected ? ", or have me work in your tabs." : "."}</p>
              {!ext.connected && <p className="muted">Install the Agent Hub extension to let me read and use your open tabs. You approve every action.</p>}
            </div>
          )}
          {messages.map((m) => (
            <article key={m.key} className={`msg ${m.role}`}>
              {m.tools.length > 0 && (
                <div className="tools">
                  {m.tools.map((t) => (
                    <span key={t.id} className={`chip ${t.state}`}>
                      {toolLabel(t.name)}
                      {t.state === "waiting" ? " · waiting for your approval" : t.summary ? ` · ${t.summary}` : t.state === "error" ? " · failed" : ""}
                    </span>
                  ))}
                </div>
              )}
              {m.plan && m.plan.length > 0 && (
                <ol className="plan" aria-label="Plan">
                  {m.plan.map((p, i) => (
                    <li key={i} className={p.status}>
                      <span className="plan-mark" aria-hidden="true">{p.status === "done" ? "✓" : p.status === "doing" ? "…" : "○"}</span>
                      {p.text}
                    </li>
                  ))}
                </ol>
              )}
              {m.role === "assistant" ? <Markdown text={m.text || (busy && !m.approvals.length ? "…" : "")} /> : <p>{m.text}</p>}
              {m.approvals.map((a) => (
                <div key={a.id} className={`approval ${a.state}`} role="group" aria-label="Action needing approval">
                  <div className="approval-head">
                    <strong>{a.state === "pending" ? "Needs your approval" : a.state === "done" ? "Done" : a.state === "denied" ? "Denied" : a.state === "expired" ? "Expired" : a.state === "working" ? "Working…" : "Failed"}</strong>
                    <span>{TOOL_LABEL[a.tool] ?? a.tool}</span>
                  </div>
                  <p className="approval-summary">{a.summary}</p>
                  {a.preview && <pre className="approval-preview">{a.preview}</pre>}
                  {a.result && a.state !== "pending" && <p className="muted">{a.result}</p>}
                  {a.state === "pending" && (
                    <div className="approval-actions">
                      <button className="btn primary" onClick={() => void decide(m.key, a.id, "approve")}>Approve</button>
                      <button className="btn" onClick={() => void decide(m.key, a.id, "deny")}>Deny</button>
                    </div>
                  )}
                </div>
              ))}
              {m.suggestions.map((html, i) => (
                <iframe key={i} className="suggest" title="Google Search suggestions" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={html} loading="lazy" />
              ))}
            </article>
          ))}
          <div ref={endRef} />
        </section>

        <footer className="composer">
          {notice && (
            <div className="notice" role="alert">
              {notice} {canContinue && <button className="link" onClick={() => void continueRun()}>Continue</button>}
            </div>
          )}
          <div className="modes" role="group" aria-label="Mode">
            <button className={`seg ${mode === "chat" ? "on" : ""}`} onClick={() => setMode("chat")}>Chat</button>
            <button className={`seg ${mode === "research" ? "on" : ""}`} onClick={() => setMode("research")}>Research</button>
            <button className={`seg ${mode === "deep" ? "on" : ""}`} onClick={() => setMode("deep")} title="Plans, searches and reads many sources. Costs 10 credits.">Deep research</button>
          </div>
          {attachments.length > 0 && (
            <div className="attached">
              {attachments.map((a) => (
                <span key={a.id} className="chip">
                  {a.name}
                  <button className="chip-x" aria-label={`Remove ${a.name}`} onClick={() => void removeAttachment(a.id)}>×</button>
                </span>
              ))}
            </div>
          )}
          <div className="box">
            <input ref={fileRef} type="file" hidden multiple accept=".pdf,.docx,.txt,.md,.csv,.json,.tsv,.log,.yaml,.yml,.xml,.html,.ts,.tsx,.js,.jsx,.py,.sql,.css" onChange={(e) => void uploadFiles(e.target.files)} />
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={mode === "deep" ? "A question worth a full report (10 credits)" : mode === "research" ? "What should I research?" : "Message Agent Hub"}
              rows={2}
              maxLength={20000}
              aria-label="Message"
            />
            <div className="actions">
              <button className="btn" onClick={() => fileRef.current?.click()} disabled={uploading || mode === "deep" || attachments.length >= 5} title="PDF, DOCX, TXT, MD, CSV, JSON up to 4 MB">{uploading ? "Uploading…" : "Attach"}</button>
              <button className="btn primary" onClick={() => void send()} disabled={busy || uploading || !input.trim()}>{busy ? "Working…" : "Send"}</button>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
