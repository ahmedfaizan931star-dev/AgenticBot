import { z } from "zod";
import { audit } from "@/lib/audit";
import { err, guard } from "@/lib/http";
import { deleteServer, getServer, setPolicy } from "@/lib/mcp/store";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard(request, { write: true, bucket: "mcp-edit", limit: 30, windowSeconds: 60 });
  if (g.response) return g.response;
  const id = idSchema.safeParse((await ctx.params).id);
  const body = z.object({ policy: z.enum(["ask_all", "ask_unless_readonly"]) }).strict().safeParse(await request.json().catch(() => null));
  if (!id.success || !body.success) return err(400, "bad_request", "Invalid request.");
  if (!(await getServer(g.user.id, id.data))) return err(404, "not_found", "App not found.");
  await setPolicy(g.user.id, id.data, body.data.policy);
  await audit(g.user.id, "mcp_policy_changed", { id: id.data, policy: body.data.policy });
  return Response.json({ ok: true });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard(request, { write: true, bucket: "mcp-del", limit: 20, windowSeconds: 60 });
  if (g.response) return g.response;
  const id = idSchema.safeParse((await ctx.params).id);
  if (!id.success) return err(400, "bad_request", "Invalid request.");
  const s = await getServer(g.user.id, id.data);
  if (!s) return err(404, "not_found", "App not found.");
  await deleteServer(g.user.id, id.data);
  await audit(g.user.id, "mcp_removed", { name: s.name });
  return Response.json({ ok: true });
}
