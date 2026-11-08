import "server-only";
import { audit } from "@/lib/audit";
import { connectionStatus } from "@/lib/connectors/store";
import { driveWrite, githubWrite } from "@/lib/connectors/write";
import { allow } from "@/lib/ratelimit";
import { createAdminClient } from "@/lib/supabase/admin";
import { executeMcp } from "@/lib/mcp/service";
import { validateMcpArgs, type ResolvedTool } from "@/lib/mcp/registry";
import { describeWrite, providerOf, type WriteTool } from "./spec";

export type ProposedAction = { id: string; tool: string; summary: string; preview: string | null };

async function setToolMessage(chatId: string, userId: string, toolCallId: string, content: string, isError: boolean) {
  await createAdminClient()
    .from("messages")
    .update({ content, is_error: isError })
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .eq("tool_call_id", toolCallId)
    .eq("role", "tool");
}

/** Validates a write the model asked for and stores it for the user to approve. Nothing runs yet. */
export async function proposeAction(userId: string, chatId: string, toolCallId: string, tool: WriteTool, raw: unknown): Promise<{ ok: true; action: ProposedAction } | { ok: false; error: string }> {
  const described = describeWrite(tool, raw);
  if (!described.ok) return { ok: false, error: described.error };
  const status = await connectionStatus(userId);
  const conn = status[providerOf(tool)];
  if (!conn) return { ok: false, error: `${providerOf(tool) === "github" ? "GitHub" : "Google Drive"} is not connected.` };
  if (conn.mode !== "write") return { ok: false, error: "Write access is not enabled for this connector. Ask the user to enable it on the Connectors page." };
  if (!(await allow(`write:${userId}`, 20, 3600))) return { ok: false, error: "Too many write requests this hour." };

  const { data, error } = await createAdminClient()
    .from("pending_actions")
    .insert({ user_id: userId, chat_id: chatId, tool_call_id: toolCallId, tool, args: described.value.args, summary: described.value.summary, preview: described.value.preview })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "Could not queue the action." };
  await audit(userId, "action_proposed", { id: data.id, tool, summary: described.value.summary });
  return { ok: true, action: { id: data.id, tool, summary: described.value.summary, preview: described.value.preview } };
}

/** Queues an MCP tool call that needs the user's approval. The stored arguments are what will run. */
export async function proposeMcpAction(userId: string, chatId: string, toolCallId: string, r: ResolvedTool, rawArgs: unknown): Promise<{ ok: true; action: ProposedAction } | { ok: false; error: string }> {
  const v = validateMcpArgs(rawArgs);
  if (!v.ok) return { ok: false, error: v.error };
  if (!(await allow(`write:${userId}`, 20, 3600))) return { ok: false, error: "Too many action requests this hour." };
  const pretty = JSON.stringify(v.args, null, 2);
  const preview = pretty.length > 1500 ? `${pretty.slice(0, 1500)}\n… (${pretty.length - 1500} more characters)` : pretty;
  const summary = `Run "${r.tool.name}" on ${r.server.name}${r.tool.destructive ? " (the app marks this as destructive)" : ""}`;
  const { data, error } = await createAdminClient()
    .from("pending_actions")
    .insert({ user_id: userId, chat_id: chatId, tool_call_id: toolCallId, tool: "mcp_call", args: { serverId: r.server.id, tool: r.tool.name, arguments: v.args }, summary, preview })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "Could not queue the action." };
  await audit(userId, "action_proposed", { id: data.id, tool: "mcp_call", summary });
  return { ok: true, action: { id: data.id, tool: "mcp_call", summary, preview } };
}

/** Marks every still-pending action in a chat as expired (used when the user moves on). */
export async function expirePending(userId: string, chatId: string) {
  const { data } = await createAdminClient()
    .from("pending_actions")
    .update({ status: "expired", decided_at: new Date().toISOString() })
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .eq("status", "pending")
    .select("id, tool_call_id");
  for (const a of data ?? []) {
    await setToolMessage(chatId, userId, a.tool_call_id, "Not approved: the user moved on. Nothing was changed.", true);
    await audit(userId, "action_expired", { id: a.id });
  }
}

export type Decision =
  | { ok: true; status: "done" | "failed" | "denied"; result: string; chatId: string }
  | { ok: false; code: "not_found" | "conflict" | "expired"; message: string };

export async function decideAction(userId: string, actionId: string, decision: "approve" | "deny"): Promise<Decision> {
  const db = createAdminClient();
  const { data: action } = await db.from("pending_actions").select("*").eq("id", actionId).eq("user_id", userId).maybeSingle();
  if (!action) return { ok: false, code: "not_found", message: "Action not found." };
  if (action.status !== "pending") return { ok: false, code: "conflict", message: `This action is already ${action.status}.` };

  if (new Date(action.expires_at).getTime() < Date.now()) {
    const { data: expired } = await db.from("pending_actions").update({ status: "expired", decided_at: new Date().toISOString() }).eq("id", actionId).eq("user_id", userId).eq("status", "pending").select("id");
    if (expired && expired.length > 0) {
      await setToolMessage(action.chat_id, userId, action.tool_call_id, "Not approved in time. Nothing was changed.", true);
      await audit(userId, "action_expired", { id: actionId });
    }
    return { ok: false, code: "expired", message: "This request expired. Ask the assistant to propose it again." };
  }

  // Claim the action. Only one request can move it out of "pending", so double clicks or replays cannot run it twice.
  const claim = await db
    .from("pending_actions")
    .update({ status: decision === "approve" ? "executing" : "denied", decided_at: new Date().toISOString() })
    .eq("id", actionId)
    .eq("user_id", userId)
    .eq("status", "pending")
    .select("id");
  if (!claim.data || claim.data.length === 0) return { ok: false, code: "conflict", message: "This action was already handled." };

  if (decision === "deny") {
    await setToolMessage(action.chat_id, userId, action.tool_call_id, "The user denied this action. Nothing was changed.", true);
    await audit(userId, "action_denied", { id: actionId, tool: action.tool });
    return { ok: true, status: "denied", result: "Denied", chatId: action.chat_id };
  }

  let ok = false;
  let text = "Action failed.";
  try {
    if (action.tool === "mcp_call") {
      const a = action.args as { serverId?: unknown; tool?: unknown; arguments?: unknown };
      const out = await executeMcp(userId, a.serverId, a.tool, a.arguments);
      ok = out.ok;
      text = out.text;
    } else {
      // Arguments are re-validated at execution time; the stored copy is the only source, never the client.
      const again = describeWrite(action.tool as WriteTool, action.args);
      if (!again.ok) text = again.error;
      else {
        const out = providerOf(action.tool as WriteTool) === "github" ? await githubWrite(userId, action.tool, again.value.args) : await driveWrite(userId, action.tool, again.value.args);
        ok = out.ok;
        text = out.text;
      }
    }
  } catch {
    text = "The action failed unexpectedly. Nothing further was done.";
  }
  const shown = text.replace(/<\/?untrusted_[a-z_]*>/gi, "").slice(0, 2000);
  text = text.slice(0, 2400);
  await db.from("pending_actions").update({ status: ok ? "done" : "failed", result: shown }).eq("id", actionId).eq("user_id", userId);
  await setToolMessage(action.chat_id, userId, action.tool_call_id, ok ? `Approved and done. ${text}` : `Approved but failed. ${text}`, !ok);
  await audit(userId, ok ? "action_done" : "action_failed", { id: actionId, tool: action.tool, summary: action.summary });
  return { ok: true, status: ok ? "done" : "failed", result: shown, chatId: action.chat_id };
}
