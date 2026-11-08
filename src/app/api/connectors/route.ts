import { connectionStatus } from "@/lib/connectors/store";
import { googleConfigured } from "@/lib/connectors/google";
import { guard } from "@/lib/http";
import { groundingEnabled } from "@/lib/search/google";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const g = await guard(request, { write: false, bucket: "connectors", limit: 60, windowSeconds: 60 });
  if (g.response) return g.response;
  const status = await connectionStatus(g.user.id);
  return Response.json(
    { google: { configured: googleConfigured(), connected: !!status.google, label: status.google?.label ?? null, mode: status.google?.mode ?? null }, github: { connected: !!status.github, label: status.github?.label ?? null, mode: status.github?.mode ?? null }, grounding: groundingEnabled() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
