import "server-only";

export type PageText = { url: string; text: string };

const TIMEOUT_MS = 20_000;
const PER_PAGE_CHARS = 3000;

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * Reads page text through the search providers' own fetchers (Exa contents, Tavily extract).
 * The server never fetches arbitrary URLs itself, so there is no SSRF surface here.
 */
export async function fetchPages(urls: string[], perPage = PER_PAGE_CHARS): Promise<PageText[]> {
  const wanted = urls.filter((u) => /^https?:\/\//i.test(u)).slice(0, 8);
  if (wanted.length === 0) return [];
  const attempts: (() => Promise<PageText[]>)[] = [];
  if (process.env.EXA_API_KEY) {
    attempts.push(async () => {
      const j = (await post("https://api.exa.ai/contents", { "x-api-key": process.env.EXA_API_KEY! }, { urls: wanted, text: { maxCharacters: perPage } })) as {
        results?: { url?: string; text?: string }[];
      };
      return (j.results ?? []).map((r) => ({ url: r.url ?? "", text: clean(r.text, perPage) }));
    });
  }
  if (process.env.TAVILY_API_KEY) {
    attempts.push(async () => {
      const j = (await post("https://api.tavily.com/extract", { Authorization: `Bearer ${process.env.TAVILY_API_KEY}` }, { urls: wanted })) as {
        results?: { url?: string; raw_content?: string }[];
      };
      return (j.results ?? []).map((r) => ({ url: r.url ?? "", text: clean(r.raw_content, perPage) }));
    });
  }
  for (const run of attempts) {
    try {
      const out = (await run()).filter((p) => p.url && p.text.length > 0);
      if (out.length > 0) return out;
    } catch {
      // try the next provider
    }
  }
  return [];
}
