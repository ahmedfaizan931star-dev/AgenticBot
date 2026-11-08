import { z } from "zod";
import { runResearchStep } from "@/lib/deep/job";
import { err, guard, ndjson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard(request, { write: true, bucket: "deep-step", limit: 40, windowSeconds: 60 });
  if (g.response) return g.response;
  const id = z.string().uuid().safeParse((await ctx.params).id);
  if (!id.success) return err(400, "bad_request", "Invalid id.");
  return ndjson(runResearchStep(g.user.id, id.data));
}
