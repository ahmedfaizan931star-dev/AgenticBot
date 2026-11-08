import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { audit } from "@/lib/audit";
import { completeOAuth } from "@/lib/connectors/google";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function GET(request: Request) {
  const url = new URL(request.url);
  const done = (q: string) => {
    const res = NextResponse.redirect(new URL(`/connectors?${q}`, url.origin));
    res.cookies.set("g_oauth", "", { path: "/api/connectors/google", maxAge: 0 });
    return res;
  };
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.redirect(new URL("/login", url.origin));

  const cookie = request.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith("g_oauth="))?.slice(8) ?? "";
  const [state, verifier, rawMode] = cookie.split(".");
  const mode = rawMode === "write" ? "write" : "read";
  const code = url.searchParams.get("code");
  const returned = url.searchParams.get("state");
  if (url.searchParams.get("error")) return done("error=google_denied");
  if (!state || !verifier || !code || !returned || !safeEq(state, returned)) return done("error=google_state");

  const ok = await completeOAuth(data.user.id, code, verifier, mode).catch(() => false);
  if (ok) await audit(data.user.id, "connector_connected", { provider: "google", mode });
  return done(ok ? "connected=google" : "error=google_failed");
}
