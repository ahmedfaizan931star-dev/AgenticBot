import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
  const { data, error } = await supabase
    .from("chats")
    .select("id, title, updated_at")
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) return Response.json({ error: { code: "server" } }, { status: 500 });
  return Response.json({ chats: data }, { headers: { "Cache-Control": "no-store" } });
}
