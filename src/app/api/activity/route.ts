import { guard } from "@/lib/http";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const g = await guard(request, { write: false, bucket: "activity", limit: 30, windowSeconds: 60 });
  if (g.response) return g.response;
  const supabase = await createClient();
  const { data } = await supabase.from("audit_log").select("id, event, detail, created_at").order("id", { ascending: false }).limit(50);
  return Response.json({ events: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
}
