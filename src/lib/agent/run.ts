import "server-only";
import { randomUUID } from "node:crypto";
import { expirePending, proposeAction, proposeMcpAction } from "@/lib/actions/store";
import { isWriteTool } from "@/lib/actions/spec";
import { mapLimit } from "@/lib/concurrency";
import { COST, InsufficientCreditsError, refund, spend } from "@/lib/credits";
import { driveRead, driveSearch } from "@/lib/connectors/google";
import { githubListIssues, githubListRepos, githubReadFile, githubSearchCode } from "@/lib/connectors/github";
import { pageText, type ToolOutput } from "@/lib/connectors/page";
import { connectionStatus } from "@/lib/connectors/store";
import { readWebpage } from "@/lib/connectors/web";
import { streamCompletion } from "@/lib/llm/provider";
import type { ChatMessage, ToolCall } from "@/lib/llm/types";
import type { McpPool } from "@/lib/mcp/client";
import type { McpRegistry, ResolvedTool } from "@/lib/mcp/registry";
import { callResolved, loadRegistry, makePool } from "@/lib/mcp/service";
import { research } from "@/lib/research";
import { googleSearch, groundingEnabled } from "@/lib/search/google";
import { wrapUntrusted } from "@/lib/security/url";
import { createAdminClient } from "@/lib/supabase/admin";
import { createChat, loadRows, ownedChat, persistMessage, touchChat } from "./chat-store";
import type { ActionCard, BrowserCall, StreamEvent } from "./events";
import { pendingToolCalls, toLlmMessages, trimHistory } from "./history";
import { buildSystemPrompt } from "./system-prompt";
import { BROWSER_TOOLS, DRIVE_TOOL_NAMES, GITHUB_TOOL_NAMES, PLAN_STEP_SCHEMA, isBrowserTool, serverToolsFor, validateBrowserCall } from "./tools";

type Common = { mode: "chat" | "research"; extension: boolean };
export type RunInput =
  | ({ kind: "user"; chatId?: string; content: string; attachments?: string[] } & Common)
  | ({ kind: "tool_results"; chatId: string; results: { toolCallId: string; content: string; isError: boolean }[] } & Common)
  | ({ kind: "continue"; chatId: string } & Common);

const MAX_TOOL_RESULT = 12000;
const MAX_NOTES = 100;
type Out = ToolOutput & { suggestionsHtml?: string };

/** Charges a credit cost, runs the tool, and gives the credits back if the tool failed. */
async function paid(userId: string, cost: number, reason: string, ref: string, run: () => Promise<Out>): Promise<Out> {
  try {
    await spend(userId, cost, reason, ref);
  } catch (e) {
    if (e instanceof InsufficientCreditsError) return { ok: false, text: "Not enough credits for this step." };
    throw e;
  }
  const out = await run();
  if (!out.ok) await refund(userId, ref);
  return out;
}

async function runServerTool(userId: string, requestId: string, call: ToolCall, args: Record<string, unknown>, mcp?: { resolved: ResolvedTool; pool: McpPool }): Promise<Out> {
  const db = createAdminClient();
  const name = call.function.name;
  const ref = `${requestId}:${name}:${call.id}`;

  if (mcp) return paid(userId, COST.mcp, name, ref, () => callResolved(userId, mcp.resolved, args, mcp.pool));
  if (name === "web_search") {
    const query = typeof args.query === "string" ? args.query.trim().slice(0, 300) : "";
    if (!query) return { ok: false, text: "Missing query" };
    return paid(userId, COST.search, name, ref, async () => {
      const out = await research(query);
      if (out.results.length === 0) return { ok: true, text: out.note ?? "No usable sources were found.", summary: "No sources found" };
      const body = out.results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n");
      return { ok: true, text: wrapUntrusted("search_results", body), summary: `${out.results.length} sources from ${out.providersUsed.join(", ")}` };
    });
  }
  if (name === "google_search") {
    if (!groundingEnabled()) return { ok: false, text: "Google search is not enabled. Use web_search." };
    return paid(userId, COST.googleSearch, name, ref, () => googleSearch(userId, args.query));
  }
  if (name === "read_webpage") return paid(userId, COST.connector, name, ref, () => readWebpage(args.url, args.offset));
  if (name === "remember") {
    const content = typeof args.content === "string" ? args.content.trim().slice(0, 500) : "";
    if (!content) return { ok: false, text: "Nothing to save" };
    const { count } = await db.from("memories").select("id", { count: "exact", head: true }).eq("user_id", userId);
    if ((count ?? 0) >= MAX_NOTES) return { ok: false, text: "Note limit reached. Ask the user to delete some notes." };
    const { error } = await db.from("memories").insert({ user_id: userId, content });
    return error ? { ok: false, text: "Could not save the note" } : { ok: true, text: "Saved.", summary: "Saved a note" };
  }
  if (name === "recall") {
    const q = typeof args.query === "string" ? args.query.trim().slice(0, 100) : "";
    let query = db.from("memories").select("content").eq("user_id", userId).order("created_at", { ascending: false }).limit(10);
    if (q) query = query.ilike("content", `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    const { data } = await query;
    const items = (data ?? []).map((m) => `- ${m.content}`);
    return { ok: true, text: items.length ? items.join("\n") : "No saved notes.", summary: `${items.length} notes` };
  }
  if (name === "read_upload") {
    const id = typeof args.fileId === "string" ? args.fileId : "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, text: "Invalid file id" };
    const { data } = await db.from("files").select("name, text_content").eq("id", id).eq("user_id", userId).maybeSingle();
    if (!data) return { ok: false, text: "File not found." };
    const { chunk, header } = pageText(data.text_content, args.offset);
    return { ok: true, text: wrapUntrusted("connector_data", `${data.name}\n${header}\n\n${chunk}`, 13000), summary: data.name.slice(0, 40) };
  }
  if (DRIVE_TOOL_NAMES.has(name) || GITHUB_TOOL_NAMES.has(name)) {
    return paid(userId, COST.connector, name, ref, async () => {
      switch (name) {
        case "drive_search":
          return driveSearch(userId, args.query);
        case "drive_read":
          return driveRead(userId, args.fileId, args.offset);
        case "github_list_repos":
          return githubListRepos(userId);
        case "github_search_code":
          return githubSearchCode(userId, args.query, args.repo);
        case "github_read_file":
          return githubReadFile(userId, args.repo, args.path, args.ref, args.offset);
        default:
          return githubListIssues(userId, args.repo, args.state);
      }
    });
  }
  return { ok: false, text: `Unknown tool ${name}` };
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function* runAgent(userId: string, input: RunInput, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  const db = createAdminClient();
  const requestId = randomUUID();

  // 1. Resolve the chat (always scoped to this user).
  let chatId: string;
  if (input.chatId) {
    const owned = await ownedChat(input.chatId, userId);
    if (!owned) return yield { type: "error", code: "not_found", message: "Chat not found." };
    chatId = owned;
  } else if (input.kind === "user") {
    const created = await createChat(userId, input.content);
    if (!created) return yield { type: "error", code: "server", message: "Could not start the chat." };
    chatId = created;
  } else {
    return yield { type: "error", code: "bad_request", message: "Missing chat." };
  }
  yield { type: "chat", chatId };

  // 2. Store the incoming message(s).
  let rows = await loadRows(chatId, userId);
  const pending = pendingToolCalls(rows);

  if (input.kind === "user") {
    await expirePending(userId, chatId);
    for (const c of pending) {
      await persistMessage(chatId, userId, { role: "tool", tool_call_id: c.id, tool_name: c.function.name, content: "Cancelled: the user moved on.", is_error: true });
    }
    let content = input.content;
    if (input.attachments && input.attachments.length > 0) {
      const { data: files } = await db.from("files").select("id, name, chars").eq("user_id", userId).in("id", input.attachments.slice(0, 5));
      if (files && files.length > 0) content += `\n\n[Attached files: ${files.map((f) => `${f.name} (id: ${f.id}, ${f.chars} characters)`).join("; ")}]`;
    }
    await persistMessage(chatId, userId, { role: "user", content });
  } else if (input.kind === "tool_results") {
    const byId = new Map(input.results.map((r) => [r.toolCallId, r]));
    for (const c of pending) {
      const r = byId.get(c.id);
      await persistMessage(chatId, userId, {
        role: "tool",
        tool_call_id: c.id,
        tool_name: c.function.name,
        content: wrapUntrusted("page_content", r ? r.content.slice(0, MAX_TOOL_RESULT) : "Not executed.", MAX_TOOL_RESULT),
        is_error: r ? r.isError : true,
      });
    }
  } else {
    // "continue": resume after approvals were decided, or after the step limit.
    if (pending.length > 0) return yield { type: "error", code: "bad_request", message: "Finish the pending browser steps first." };
    const { count } = await db.from("pending_actions").select("id", { count: "exact", head: true }).eq("chat_id", chatId).eq("user_id", userId).in("status", ["pending", "executing"]);
    if ((count ?? 0) > 0) return yield { type: "error", code: "approval_pending", message: "Approve or deny the waiting actions first." };
  }
  rows = await loadRows(chatId, userId);

  // 3. Build model context.
  const { data: noteRows } = await db.from("memories").select("content").eq("user_id", userId).order("created_at", { ascending: false }).limit(15);
  const connected = await connectionStatus(userId);
  const grounding = groundingEnabled();
  const { servers, registry } = await loadRegistry(userId);
  const pool = makePool(userId, servers);
  const mcpApps = [...new Set([...registry.resolve.values()].map((r) => r.server.name))];
  const system = buildSystemPrompt({
    now: new Date(),
    mode: input.mode,
    extension: input.extension,
    notes: (noteRows ?? []).map((n) => n.content),
    connectors: { google: connected.google?.mode, github: connected.github?.mode },
    googleSearch: grounding,
    mcpApps,
  });
  const serverTools = serverToolsFor(connected, { grounding });
  const allServerTools = [...serverTools, ...registry.tools];
  const tools = input.extension ? [...allServerTools, ...BROWSER_TOOLS] : allServerTools;
  const maxSteps = input.mode === "research" ? 12 : 8;

  // 4. Agent loop. App sessions opened during this request are always closed, however the loop ends.
  try {
  for (let step = 0; step < maxSteps; step++) {
    const spendRef = `${requestId}:llm:${step}`;
    try {
      yield { type: "credits", balance: await spend(userId, COST.llmRound, input.mode, spendRef) };
    } catch (e) {
      if (e instanceof InsufficientCreditsError) return yield { type: "error", code: "insufficient_credits", message: "You are out of credits." };
      return yield { type: "error", code: "server", message: "Could not check credits." };
    }

    const messages: ChatMessage[] = [{ role: "system", content: system }, ...toLlmMessages(trimHistory(rows))];
    let text = "";
    let calls: ToolCall[] = [];
    try {
      for await (const ev of streamCompletion({ messages, tools, signal })) {
        if (ev.type === "text") {
          text += ev.delta;
          yield { type: "text", delta: ev.delta };
        } else if (ev.type === "tool_calls") calls = ev.calls;
      }
    } catch {
      if (text.length === 0) await refund(userId, spendRef);
      return yield { type: "error", code: "model_unavailable", message: "The model is unavailable right now. Try again in a moment." };
    }

    await persistMessage(chatId, userId, { role: "assistant", content: text || null, tool_calls: calls.length ? calls : null });
    if (calls.length === 0) break;

    const browserCalls: BrowserCall[] = [];
    const proposals: ActionCard[] = [];
    const serverCalls: { call: ToolCall; args: Record<string, unknown>; mcp?: ResolvedTool }[] = [];
    const fail = (call: ToolCall, msg: string) => persistMessage(chatId, userId, { role: "tool", tool_call_id: call.id, tool_name: call.function.name, content: msg, is_error: true });

    for (const call of calls) {
      const name = call.function.name;
      const args = parseArgs(call.function.arguments);
      if (!args) {
        await fail(call, "Invalid arguments");
      } else if (isBrowserTool(name)) {
        const v = input.extension ? validateBrowserCall(name, args) : ({ ok: false, error: "Browser extension is not connected." } as const);
        if (v.ok) browserCalls.push({ id: call.id, name, args: v.args });
        else await fail(call, v.error);
      } else if (registry.resolve.has(name)) {
        const r = registry.resolve.get(name)!;
        if (r.needsApproval) {
          const p = await proposeMcpAction(userId, chatId, call.id, r, args);
          if (p.ok) {
            proposals.push(p.action);
            await persistMessage(chatId, userId, {
              role: "tool",
              tool_call_id: call.id,
              tool_name: name,
              content: "Waiting for the user to approve this action. It has NOT happened yet. Do not say it is done; tell the user it needs their approval.",
            });
          } else await fail(call, p.error);
        } else serverCalls.push({ call, args, mcp: r });
      } else if (isWriteTool(name)) {
        const p = await proposeAction(userId, chatId, call.id, name, args);
        if (p.ok) {
          proposals.push(p.action);
          await persistMessage(chatId, userId, {
            role: "tool",
            tool_call_id: call.id,
            tool_name: name,
            content: "Waiting for the user to approve this action. It has NOT happened yet. Do not say it is done; tell the user it needs their approval.",
          });
        } else await fail(call, p.error);
      } else if (name === "update_plan") {
        const plan = PLAN_STEP_SCHEMA.safeParse(args);
        if (plan.success) {
          yield { type: "plan", steps: plan.data.steps };
          await persistMessage(chatId, userId, { role: "tool", tool_call_id: call.id, tool_name: name, content: "Plan updated." });
        } else await fail(call, "Invalid plan");
      } else serverCalls.push({ call, args });
    }

    // Independent lookups run at the same time.
    for (const s of serverCalls) yield { type: "tool_status", id: s.call.id, name: s.call.function.name, state: "running" };
    const settled = await mapLimit(serverCalls, 6, (s) => runServerTool(userId, requestId, s.call, s.args, s.mcp ? { resolved: s.mcp, pool } : undefined));
    const results = settled.map((r): Out => (r.status === "fulfilled" ? r.value : { ok: false, text: "Tool failed" }));
    for (const [i, s] of serverCalls.entries()) {
      const r = results[i]!;
      const meta = r.suggestionsHtml ? { suggestionsHtml: r.suggestionsHtml } : null;
      await persistMessage(chatId, userId, { role: "tool", tool_call_id: s.call.id, tool_name: s.call.function.name, content: r.text, is_error: !r.ok, meta });
      yield { type: "tool_status", id: s.call.id, name: s.call.function.name, state: r.ok ? "done" : "error", summary: r.summary };
      if (r.suggestionsHtml) yield { type: "suggestions", id: s.call.id, html: r.suggestionsHtml };
    }

    rows = await loadRows(chatId, userId);
    if (browserCalls.length > 0 || proposals.length > 0) {
      if (browserCalls.length > 0) yield { type: "browser_tool_calls", calls: browserCalls };
      for (const action of proposals) yield { type: "approval_required", action };
      yield proposals.length > 0 && browserCalls.length === 0 ? { type: "awaiting_approval" } : { type: "awaiting_tools" };
      await touchChat(chatId, userId);
      return;
    }
    if (step === maxSteps - 1) yield { type: "error", code: "step_limit", message: "Paused after several steps. Tap Continue to keep going." };
  }

  await touchChat(chatId, userId);
  yield { type: "done" };
  } finally {
    await pool.closeAll();
  }
}
