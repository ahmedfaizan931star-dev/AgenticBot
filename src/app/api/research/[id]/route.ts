import { z } from "zod";
import { err, guard } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard(request, { write: false, bucket: "deep-status", limit: 60, windowSeconds: 60 });
  if (g.response) return g.response;
  const id = z.string().uuid().safeParse((await ctx.params).id);
  if (!id.success) return err(400, "bad_request", "Invalid id.");
  const { data } = await createAdminClient().from("research_jobs").select("id, chat_id, phase, error").eq("id", id.data).eq("user_id", g.user.id).maybeSingle();
  if (!data) return err(404, "not_found", "Not found.");
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
