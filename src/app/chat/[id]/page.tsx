import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { ChatApp } from "@/components/ChatApp";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  // "new" starts a blank chat; anything else must be a chat id.
  if (id === "new") return <ChatApp email={data.user.email ?? ""} startFresh />;
  if (!z.string().uuid().safeParse(id).success) notFound();
  return <ChatApp initialChatId={id} email={data.user.email ?? ""} />;
}
