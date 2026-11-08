import { getBalance } from "@/lib/credits";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
  const balance = await getBalance(data.user.id);
  return Response.json({ balance }, { headers: { "Cache-Control": "no-store" } });
}
