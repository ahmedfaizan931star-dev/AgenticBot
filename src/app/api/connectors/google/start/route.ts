import { NextResponse } from "next/server";
import { authUrl, googleConfigured, newPkce } from "@/lib/connectors/google";
import { guard } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const g = await guard(request, { write: false, bucket: "oauth", limit: 10, windowSeconds: 60 });
  if (g.response) return g.response;
  if (!googleConfigured()) return NextResponse.redirect(new URL("/connectors?error=google_not_configured", request.url));
  const mode = new URL(request.url).searchParams.get("mode") === "write" ? "write" : "read";
  const { verifier, challenge, state } = newPkce();
  const res = NextResponse.redirect(authUrl(state, challenge, mode));
  // The state and PKCE verifier live in a short-lived, httpOnly cookie so the callback can prove this browser started the flow.
  res.cookies.set("g_oauth", `${state}.${verifier}.${mode}`, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/connectors/google", maxAge: 600 });
  return res;
}
