import { z } from "zod";
import { err, guard } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard(request, { write: true, bucket: "upload-del", limit: 30, windowSeconds: 60 });
  if (g.response) return g.response;
  const id = z.string().uuid().safeParse((await ctx.params).id);
  if (!id.success) return err(400, "bad_request", "Invalid id.");
  await createAdminClient().from("files").delete().eq("id", id.data).eq("user_id", g.user.id);
  return Response.json({ ok: true });
}
