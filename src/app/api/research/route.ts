import { z } from "zod";
import { createChat, ownedChat, persistMessage, loadRows } from "@/lib/agent/chat-store";
import { pendingToolCalls } from "@/lib/agent/history";
import { COST, InsufficientCreditsError, spend } from "@/lib/credits";
import { err, guard } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const body = z.object({ chatId: z.string().uuid().optional(), content: z.string().trim().min(3).max(2000) });

/** Starts a deep-research job. Work then happens in small steps (POST /api/research/:id/step) driven by the browser. */
export async function POST(request: Request) {
  const g = await guard(request, { write: true, bucket: "deep-start", limit: 5, windowSeconds: 600 });
  if (g.response) return g.response;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return err(400, "bad_request", "Write the research question (3 to 2000 characters).");

  const userId = g.user.id;
  let chatId: string | null;
  if (parsed.data.chatId) {
    chatId = await ownedChat(parsed.data.chatId, userId);
    if (!chatId) return err(404, "not_found", "Chat not found.");
  } else {
    chatId = await createChat(userId, parsed.data.content);
    if (!chatId) return err(500, "server", "Could not start the chat.");
  }

  const db = createAdminClient();
  const { data: job, error } = await db.from("research_jobs").insert({ user_id: userId, chat_id: chatId, question: parsed.data.content }).select("id").single();
  if (error || !job) return err(500, "server", "Could not start the research.");

  try {
    await spend(userId, COST.deepResearch, "deep_research", `job:${job.id}`);
  } catch (e) {
    await db.from("research_jobs").delete().eq("id", job.id).eq("user_id", userId);
    if (e instanceof InsufficientCreditsError) return err(402, "insufficient_credits", `Deep research costs ${COST.deepResearch} credits.`);
    return err(500, "server", "Could not check credits.");
  }

  for (const c of pendingToolCalls(await loadRows(chatId, userId))) {
    await persistMessage(chatId, userId, { role: "tool", tool_call_id: c.id, tool_name: c.function.name, content: "Cancelled: the user moved on.", is_error: true });
  }
  await persistMessage(chatId, userId, { role: "user", content: parsed.data.content });
  return Response.json({ jobId: job.id, chatId });
}
