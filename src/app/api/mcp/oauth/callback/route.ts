import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { finishOauth } from "@/lib/mcp/service";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (q: string) => NextResponse.redirect(new URL(`/connectors?${q}`, url.origin));
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.redirect(new URL("/login", url.origin));
  if (url.searchParams.get("error")) return back("mcp=denied");
  const r = await finishOauth(data.user.id, url.searchParams);
  if (!r.ok) return back(`mcp=error&reason=${encodeURIComponent(r.error.slice(0, 120))}`);
  await audit(data.user.id, "mcp_signed_in", {});
  return back("mcp=connected");
}
