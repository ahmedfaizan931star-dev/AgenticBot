import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "@/lib/http";
import { startOauth } from "@/lib/mcp/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const g = await guard(request, { write: false, bucket: "mcp-oauth", limit: 10, windowSeconds: 60 });
  if (g.response) return g.response;
  const id = z.string().uuid().safeParse(new URL(request.url).searchParams.get("server"));
  const back = (q: string) => NextResponse.redirect(new URL(`/connectors?${q}`, request.url));
  if (!id.success) return back("mcp=error");
  const r = await startOauth(g.user.id, id.data);
  if (!r.ok) return back(`mcp=error&reason=${encodeURIComponent(r.error.slice(0, 120))}`);
  return r.redirectTo ? NextResponse.redirect(r.redirectTo) : back("mcp=connected");
}
