import { redirect } from "next/navigation";
import { ConnectorsPanel } from "@/components/ConnectorsPanel";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ConnectorsPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  return <ConnectorsPanel />;
}
