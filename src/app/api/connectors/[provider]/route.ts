import { audit } from "@/lib/audit";
import { revokeGoogle } from "@/lib/connectors/google";
import { deleteConnection } from "@/lib/connectors/store";
import { err, guard } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  const g = await guard(request, { write: true, bucket: "connectors-del", limit: 10, windowSeconds: 60 });
  if (g.response) return g.response;
  const { provider } = await ctx.params;
  if (provider === "google") await revokeGoogle(g.user.id);
  else if (provider === "github") await deleteConnection(g.user.id, "github");
  else return err(404, "not_found", "Unknown connector.");
  await audit(g.user.id, "connector_disconnected", { provider });
  return Response.json({ ok: true });
}
