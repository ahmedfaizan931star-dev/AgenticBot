import { z } from "zod";
import { isSameOrigin } from "@/lib/security/url";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const id = idSchema.safeParse((await ctx.params).id);
  if (!id.success) return Response.json({ error: { code: "bad_request" } }, { status: 400 });
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return Response.json({ error: { code: "unauthorized" } }, { status: 401 });

  const { data: chat } = await supabase.from("chats").select("id, title").eq("id", id.data).maybeSingle();
  if (!chat) return Response.json({ error: { code: "not_found" } }, { status: 404 });
  const { data: messages, error } = await supabase
    .from("messages")
    .select("id, role, content, tool_calls, tool_call_id, tool_name, is_error, meta")
    .eq("chat_id", id.data)
    .order("seq", { ascending: true })
    .limit(500);
  if (error) return Response.json({ error: { code: "server" } }, { status: 500 });
  const { data: job } = await supabase
    .from("research_jobs")
    .select("id, phase")
    .eq("chat_id", id.data)
    .in("phase", ["plan", "search", "read", "write"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: actions } = await supabase
    .from("pending_actions")
    .select("id, tool_call_id, tool, summary, preview, status, result")
    .eq("chat_id", id.data)
    .order("created_at", { ascending: true })
    .limit(50);
  return Response.json({ chat, messages, activeJob: job ?? null, actions: actions ?? [] }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: Request, ctx: Ctx) {
  if (!isSameOrigin(req)) return Response.json({ error: { code: "forbidden" } }, { status: 403 });
  const id = idSchema.safeParse((await ctx.params).id);
  if (!id.success) return Response.json({ error: { code: "bad_request" } }, { status: 400 });
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
  const { error } = await supabase.from("chats").delete().eq("id", id.data);
  if (error) return Response.json({ error: { code: "server" } }, { status: 500 });
  return Response.json({ ok: true });
}
