import "server-only";

export type SearchResult = { title: string; url: string; snippet: string; source: "brave" | "tavily" | "exa" };
export type ResearchOutcome = {
  results: SearchResult[];
  providersUsed: string[];
  providersFailed: string[];
  note?: string;
};

const TIMEOUT_MS = 7000;
const TRACKING = /^(utm_|fbclid|gclid|mc_|ref$|ref_)/i;

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    return `${host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return raw;
  }
}

/** Round-robins providers so no single provider dominates, dropping duplicate URLs and non-http(s) links. */
export function mergeResults(perProvider: SearchResult[][], limit: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  const max = Math.max(0, ...perProvider.map((r) => r.length));
  for (let i = 0; i < max && out.length < limit; i++) {
    for (const list of perProvider) {
      const r = list[i];
      if (!r || !/^https?:\/\//i.test(r.url)) continue;
      const key = normalizeUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}

async function getJson(url: string, init: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const clip = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");

async function brave(query: string, n: number): Promise<SearchResult[]> {
  const key = process.env.BRAVE_API_KEY!;
  const j = (await getJson(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`,
    { headers: { Accept: "application/json", "X-Subscription-Token": key } },
  )) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
  return (j.web?.results ?? []).map((r) => ({
    title: clip(r.title, 200),
    url: r.url ?? "",
    snippet: clip(r.description, 400),
    source: "brave" as const,
  }));
}

async function tavily(query: string, n: number): Promise<SearchResult[]> {
  const key = process.env.TAVILY_API_KEY!;
  const j = (await getJson("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: n }),
  })) as { results?: { title?: string; url?: string; content?: string }[] };
  return (j.results ?? []).map((r) => ({
    title: clip(r.title, 200),
    url: r.url ?? "",
    snippet: clip(r.content, 400),
    source: "tavily" as const,
  }));
}

async function exa(query: string, n: number): Promise<SearchResult[]> {
  const key = process.env.EXA_API_KEY!;
  const j = (await getJson("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query, numResults: n, contents: { text: { maxCharacters: 400 } } }),
  })) as { results?: { title?: string; url?: string; text?: string }[] };
  return (j.results ?? []).map((r) => ({
    title: clip(r.title, 200),
    url: r.url ?? "",
    snippet: clip(r.text, 400),
    source: "exa" as const,
  }));
}

/** Multi-provider search with cross-checking. Never invents results: an empty outcome is reported honestly. */
export async function research(query: string, limit = 8): Promise<ResearchOutcome> {
  const jobs: { name: string; run: () => Promise<SearchResult[]> }[] = [];
  if (process.env.BRAVE_API_KEY) jobs.push({ name: "brave", run: () => brave(query, limit) });
  if (process.env.TAVILY_API_KEY) jobs.push({ name: "tavily", run: () => tavily(query, limit) });
  if (process.env.EXA_API_KEY) jobs.push({ name: "exa", run: () => exa(query, limit) });
  if (jobs.length === 0) {
    return { results: [], providersUsed: [], providersFailed: [], note: "No search provider is configured." };
  }
  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  const lists: SearchResult[][] = [];
  const used: string[] = [];
  const failed: string[] = [];
  settled.forEach((s, i) => {
    const name = jobs[i]!.name;
    if (s.status === "fulfilled") {
      lists.push(s.value);
      used.push(name);
    } else failed.push(name);
  });
  const results = mergeResults(lists, limit);
  return {
    results,
    providersUsed: used,
    providersFailed: failed,
    note: results.length === 0 ? "No usable sources were found." : undefined,
  };
}
