import { z } from "zod";
import { audit } from "@/lib/audit";
import { connectGithub } from "@/lib/connectors/github";
import { err, guard } from "@/lib/http";

export const dynamic = "force-dynamic";
const body = z.object({ token: z.string().trim().min(20).max(255), mode: z.enum(["read", "write"]).default("read") });

export async function POST(request: Request) {
  const g = await guard(request, { write: true, bucket: "gh-connect", limit: 5, windowSeconds: 60 });
  if (g.response) return g.response;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return err(400, "bad_request", "Paste a GitHub token.");
  const r = await connectGithub(g.user.id, parsed.data.token, parsed.data.mode);
  if (!r.ok) return err(400, "invalid_token", r.error);
  await audit(g.user.id, "connector_connected", { provider: "github", mode: parsed.data.mode, account: r.label });
  return Response.json({ ok: true, label: r.label, warning: r.warning ?? null });
}
