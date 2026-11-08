import type { McpServerInfo } from "./types";

/** What the browser may see about a server: never a credential, never raw server-controlled markup beyond short text. */
export function serverView(s: McpServerInfo) {
  const enabled = new Set(s.enabledTools);
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    host: (() => {
      try {
        return new URL(s.url).host;
      } catch {
        return "";
      }
    })(),
    authType: s.authType,
    policy: s.policy,
    status: s.status,
    lastError: s.lastError,
    changedSinceReview: s.reviewedHash !== null && s.toolsHash !== null && s.toolsHash !== s.reviewedHash,
    tools: s.tools.map((t) => ({ name: t.name, description: t.description.slice(0, 300), readOnly: t.readOnly, destructive: t.destructive, enabled: enabled.has(t.name) })),
  };
}
