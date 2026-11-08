import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/security/url";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: { code: "forbidden" } }, { status: 403 });
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
