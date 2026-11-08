import { z } from "zod";
import { decideAction } from "@/lib/actions/store";
import { err, guard } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({ decision: z.enum(["approve", "deny"]) }).strict();

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard(request, { write: true, bucket: "action", limit: 30, windowSeconds: 60 });
  if (g.response) return g.response;
  const id = z.string().uuid().safeParse((await ctx.params).id);
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!id.success || !parsed.success) return err(400, "bad_request", "Invalid request.");

  const r = await decideAction(g.user.id, id.data, parsed.data.decision);
  if (!r.ok) return err(r.code === "not_found" ? 404 : r.code === "expired" ? 410 : 409, r.code, r.message);
  return Response.json({ status: r.status, result: r.result, chatId: r.chatId }, { headers: { "Cache-Control": "no-store" } });
}
