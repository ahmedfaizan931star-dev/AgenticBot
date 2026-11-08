/** Only same-site relative paths are allowed as post-login redirects (blocks open redirects). */
export function safeRedirectPath(next: string | null | undefined, fallback = "/chat"): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  if (/[\u0000-\u001f]/.test(next)) return fallback;
  return next;
}

/** URLs the agent may open in the user's browser: http(s) only, no embedded credentials. */
export function validateBrowserUrl(raw: unknown): { ok: true; url: string } | { ok: false; reason: string } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return { ok: false, reason: "Invalid URL" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "Only http(s) links are allowed" };
  if (u.username || u.password) return { ok: false, reason: "Links with credentials are not allowed" };
  return { ok: true, url: u.toString() };
}

/** Rejects cross-site browser requests to state-changing endpoints. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const CLOSE_TAG = /<\/?\s*untrusted_[a-z_]*\s*>/gi;

/** Wraps third-party text (web pages, search results) so the model treats it as data, never instructions. */
export function wrapUntrusted(kind: "page_content" | "search_results" | "connector_data", text: string, maxChars = 12000): string {
  const cleaned = text.replace(CLOSE_TAG, "").slice(0, maxChars);
  return `<untrusted_${kind}>\n${cleaned}\n</untrusted_${kind}>`;
}
