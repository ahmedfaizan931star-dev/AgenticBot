"use client";

const CHANNEL = "agent-hub";

export type ExtensionStatus = { connected: boolean; enabled?: boolean; tabAccess?: boolean; version?: string };
export type BridgeReply = { ok: true; result: unknown } | { ok: false; error: string };

function call(action: "ping" | "tool", tool: string | undefined, args: Record<string, unknown> | undefined, timeoutMs: number): Promise<BridgeReply> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs);
    function onMessage(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const d = event.data as { channel?: string; dir?: string; id?: string; ok?: boolean; result?: unknown; error?: string } | null;
      if (!d || d.channel !== CHANNEL || d.dir !== "from-ext" || d.id !== id) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(d.ok ? { ok: true, result: d.result } : { ok: false, error: d.error ?? "Failed" });
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ channel: CHANNEL, dir: "to-ext", id, action, tool, args }, window.location.origin);
  });
}

export async function pingExtension(): Promise<ExtensionStatus> {
  const r = await call("ping", undefined, undefined, 1500);
  if (!r.ok) return { connected: false };
  const v = r.result as { version?: string; enabled?: boolean; tabAccess?: boolean };
  return { connected: true, version: v.version, enabled: v.enabled, tabAccess: v.tabAccess };
}

/** Waits up to 3 minutes: the user may take a while to approve in the extension window. */
export function runBrowserTool(tool: string, args: Record<string, unknown>): Promise<BridgeReply> {
  return call("tool", tool, args, 180_000);
}
