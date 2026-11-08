import { z } from "zod";
import { audit } from "@/lib/audit";
import { err, guard } from "@/lib/http";
import { assertPublicUrl } from "@/lib/mcp/ssrf";
import { discoverServer } from "@/lib/mcp/service";
import { createServer, listServers } from "@/lib/mcp/store";
import { serverView } from "@/lib/mcp/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z
  .object({
    name: z.string().trim().min(1).max(60),
    url: z.string().trim().min(8).max(2048),
    auth: z.enum(["none", "bearer", "oauth"]),
    token: z.string().trim().min(1).max(4000).optional(),
    policy: z.enum(["ask_all", "ask_unless_readonly"]).default("ask_unless_readonly"),
  })
  .strict();

export async function GET(request: Request) {
  const g = await guard(request, { write: false, bucket: "mcp-list", limit: 60, windowSeconds: 60 });
  if (g.response) return g.response;
  return Response.json({ servers: (await listServers(g.user.id)).map(serverView) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const g = await guard(request, { write: true, bucket: "mcp-add", limit: 10, windowSeconds: 3600 });
  if (g.response) return g.response;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return err(400, "bad_request", "Check the name, address and token.");
  const { name, url, auth, token, policy } = parsed.data;
  if (auth === "bearer" && !token) return err(400, "bad_request", "Paste the access token for this app.");
  const checked = assertPublicUrl(url);
  if (!checked.ok) return err(400, "bad_url", checked.reason);

  const made = await createServer(g.user.id, { name, url: checked.url.toString(), authType: auth, token: auth === "bearer" ? token : undefined, policy });
  if (!made.ok) return err(409, "cannot_add", made.error);
  await audit(g.user.id, "mcp_connected", { name, host: checked.url.host, auth });

  if (auth === "oauth") return Response.json({ server: serverView(made.server), nextStep: "oauth" });
  const d = await discoverServer(g.user.id, made.server.id);
  const fresh = d.ok ? d.server : made.server;
  return Response.json({ server: serverView(fresh), discoveryError: d.ok ? null : d.error });
}
