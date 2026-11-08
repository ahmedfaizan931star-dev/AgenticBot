import { redirect } from "next/navigation";
import { ChatApp } from "@/components/ChatApp";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ChatHome() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  return <ChatApp email={data.user.email ?? ""} />;
}
