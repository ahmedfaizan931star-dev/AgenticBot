import "server-only";
import { decrypt, encrypt } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";

export type Provider = "google" | "github";
export type Mode = "read" | "write";
export type ConnectionStatus = Partial<Record<Provider, { label: string | null; mode: Mode }>>;

export async function connectionStatus(userId: string): Promise<ConnectionStatus> {
  const { data } = await createAdminClient().from("connections").select("provider, label, mode").eq("user_id", userId);
  const out: ConnectionStatus = {};
  for (const r of data ?? []) out[r.provider] = { label: r.label, mode: r.mode };
  return out;
}

export async function saveConnection(
  userId: string,
  provider: Provider,
  v: { token: string; refresh?: string | null; expiresAt?: Date | null; label?: string | null; scopes?: string | null; mode?: Mode },
) {
  const { error } = await createAdminClient()
    .from("connections")
    .upsert(
      {
        user_id: userId,
        provider,
        token_enc: encrypt(v.token),
        refresh_enc: v.refresh ? encrypt(v.refresh) : null,
        expires_at: v.expiresAt ? v.expiresAt.toISOString() : null,
        label: v.label ?? null,
        scopes: v.scopes ?? null,
        ...(v.mode ? { mode: v.mode } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,provider" },
    );
  if (error) throw error;
}

export type LoadedConnection = { token: string; refresh: string | null; expiresAt: Date | null; label: string | null; mode: Mode };

export async function loadConnection(userId: string, provider: Provider): Promise<LoadedConnection | null> {
  const { data } = await createAdminClient()
    .from("connections")
    .select("token_enc, refresh_enc, expires_at, label, mode")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (!data) return null;
  try {
    return {
      token: decrypt(data.token_enc),
      refresh: data.refresh_enc ? decrypt(data.refresh_enc) : null,
      expiresAt: data.expires_at ? new Date(data.expires_at) : null,
      label: data.label,
      mode: data.mode,
    };
  } catch {
    return null;
  }
}

export async function deleteConnection(userId: string, provider: Provider) {
  await createAdminClient().from("connections").delete().eq("user_id", userId).eq("provider", provider);
}
