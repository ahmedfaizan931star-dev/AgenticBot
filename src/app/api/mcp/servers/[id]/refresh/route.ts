import { z } from "zod";
import { err, guard } from "@/lib/http";
import { discoverServer } from "@/lib/mcp/service";
import { serverView } from "@/lib/mcp/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard(request, { write: true, bucket: "mcp-refresh", limit: 20, windowSeconds: 600 });
  if (g.response) return g.response;
  const id = z.string().uuid().safeParse((await ctx.params).id);
  if (!id.success) return err(400, "bad_request", "Invalid request.");
  const d = await discoverServer(g.user.id, id.data);
  if (!d.ok) return err(d.needsAuth ? 401 : 502, d.needsAuth ? "needs_auth" : "unreachable", d.error);
  return Response.json({ server: serverView(d.server) });
}
