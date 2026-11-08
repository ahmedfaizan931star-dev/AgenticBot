import { CHANNEL, type ExtReply, type PageToExt } from "./shared";

// Relays messages between the Agent Hub web page and the extension background.
// Only runs on the configured app origin (see manifest content_scripts.matches).
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const d = event.data as { channel?: string; dir?: string; id?: unknown; action?: string; tool?: string; args?: Record<string, unknown> } | null;
  if (!d || d.channel !== CHANNEL || d.dir !== "to-ext" || typeof d.id !== "string" || d.id.length > 100) return;
  if (d.action !== "ping" && d.action !== "tool") return;

  const payload: PageToExt = { action: d.action, tool: typeof d.tool === "string" ? d.tool : undefined, args: d.args && typeof d.args === "object" ? d.args : undefined };
  const reply = (r: ExtReply) => window.postMessage({ channel: CHANNEL, dir: "from-ext", id: d.id, ...r }, location.origin);
  chrome.runtime
    .sendMessage({ kind: "page-request", payload })
    .then((r: ExtReply) => reply(r))
    .catch(() => reply({ ok: false, error: "Extension is not responding. Reload the page." }));
});
