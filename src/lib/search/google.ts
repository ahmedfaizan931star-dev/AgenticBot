import "server-only";
import { allow } from "@/lib/ratelimit";
import { wrapUntrusted } from "@/lib/security/url";
import type { ToolOutput } from "@/lib/connectors/page";

/**
 * Google Search through Gemini "Grounding with Google Search" (the only supported way to get Google results now that
 * the Custom Search JSON API is closed to new customers). Off unless GOOGLE_GROUNDING_ENABLED=true.
 * Google's terms require showing the returned Search Suggestions, so they are passed back for the UI to render.
 */
export const groundingEnabled = () => process.env.GOOGLE_GROUNDING_ENABLED === "true" && !!process.env.GEMINI_API_KEY;

export type GroundedOutput = ToolOutput & { suggestionsHtml?: string };

type GroundingResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: { web?: { uri?: string; title?: string } }[];
      searchEntryPoint?: { renderedContent?: string };
    };
  }[];
};

export function parseGrounded(json: GroundingResponse): { answer: string; sources: { uri: string; title: string }[]; queries: string[]; html?: string } {
  const c = json.candidates?.[0];
  const answer = (c?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  const seen = new Set<string>();
  const sources: { uri: string; title: string }[] = [];
  for (const ch of c?.groundingMetadata?.groundingChunks ?? []) {
    const uri = ch.web?.uri;
    if (!uri || !/^https:\/\//i.test(uri) || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ uri, title: (ch.web?.title ?? "").slice(0, 120) });
  }
  const html = c?.groundingMetadata?.searchEntryPoint?.renderedContent;
  return { answer, sources: sources.slice(0, 10), queries: c?.groundingMetadata?.webSearchQueries ?? [], html: html && html.length <= 30_000 ? html : undefined };
}

export async function googleSearch(userId: string, query: unknown): Promise<GroundedOutput> {
  if (!groundingEnabled()) return { ok: false, text: "Google search is not enabled on this server." };
  const q = typeof query === "string" ? query.trim().slice(0, 300) : "";
  if (!q) return { ok: false, text: "Missing query" };

  // Daily caps keep usage inside Google's free allowance. A free-tier key cannot be billed.
  const perUser = Number(process.env.GOOGLE_GROUNDING_USER_DAILY ?? 20);
  const global = Number(process.env.GOOGLE_GROUNDING_DAILY_CAP ?? 400);
  if (!(await allow(`gsearch:g`, global, 86400))) return { ok: false, text: "Google search has reached today's limit. Use web_search instead." };
  if (!(await allow(`gsearch:u:${userId}`, perUser, 86400))) return { ok: false, text: "You reached today's Google search limit. Use web_search instead." };

  const model = process.env.GOOGLE_GROUNDING_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `Search the web and answer briefly with the key facts and dates: ${q}` }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 900 },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, text: `Google search failed (${res.status}). Use web_search instead.` };
    const p = parseGrounded((await res.json()) as GroundingResponse);
    if (p.sources.length === 0 && !p.answer) return { ok: true, text: "No usable sources were found.", summary: "No sources" };
    const body = `${p.answer}\n\nSources:\n${p.sources.map((s, i) => `${i + 1}. ${s.title || "source"}\n${s.uri}`).join("\n")}`;
    return { ok: true, text: wrapUntrusted("search_results", body), summary: `${p.sources.length} Google sources`, suggestionsHtml: p.html };
  } catch {
    return { ok: false, text: "Google search timed out. Use web_search instead." };
  } finally {
    clearTimeout(timer);
  }
}
