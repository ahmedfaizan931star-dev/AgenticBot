import { z } from "zod";
import { audit } from "@/lib/audit";
import { err, guard } from "@/lib/http";
import { getServer, reviewServer } from "@/lib/mcp/store";
import { serverView } from "@/lib/mcp/view";

export const dynamic = "force-dynamic";

/** The user accepts the current tool list (and picks which tools are on). Until then nothing from this app reaches the model. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard(request, { write: true, bucket: "mcp-review", limit: 30, windowSeconds: 60 });
  if (g.response) return g.response;
  const id = z.string().uuid().safeParse((await ctx.params).id);
  const body = z.object({ enabledTools: z.array(z.string().max(128)).max(100) }).strict().safeParse(await request.json().catch(() => null));
  if (!id.success || !body.success) return err(400, "bad_request", "Invalid request.");
  const r = await reviewServer(g.user.id, id.data, body.data.enabledTools);
  if (!r.ok) return err(409, "cannot_review", r.error);
  await audit(g.user.id, "mcp_reviewed", { id: id.data, enabled: body.data.enabledTools.length });
  return Response.json({ server: serverView((await getServer(g.user.id, id.data))!) });
}
