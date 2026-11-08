import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeResults, normalizeUrl, research, type SearchResult } from "@/lib/research";

const r = (url: string, source: SearchResult["source"]): SearchResult => ({ title: url, url, snippet: "", source });

describe("normalizeUrl / mergeResults", () => {
  it("normalizes www, tracking params, trailing slash and hash", () => {
    expect(normalizeUrl("https://www.Example.com/a/?utm_source=x&id=1#top")).toBe("example.com/a?id=1");
  });
  it("interleaves providers, dedupes and drops non-http links", () => {
    const merged = mergeResults(
      [[r("https://a.com/1", "brave"), r("https://b.com/", "brave")], [r("https://www.a.com/1/", "tavily"), r("javascript:alert(1)", "tavily"), r("https://c.com", "tavily")]],
      10,
    );
    expect(merged.map((x) => x.url)).toEqual(["https://a.com/1", "https://b.com/", "https://c.com"]);
  });
  it("respects the limit", () => expect(mergeResults([[r("https://a.com", "brave"), r("https://b.com", "brave")]], 1)).toHaveLength(1));
});

describe("research()", () => {
  beforeEach(() => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("TAVILY_API_KEY", "");
    vi.stubEnv("EXA_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reports honestly when nothing is configured", async () => {
    const out = await research("x");
    expect(out.results).toEqual([]);
    expect(out.note).toMatch(/No search provider/);
  });

  it("survives one provider failing and still returns the other's results", async () => {
    vi.stubEnv("BRAVE_API_KEY", "k");
    vi.stubEnv("TAVILY_API_KEY", "k");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("brave")) return new Response("boom", { status: 500 });
        return Response.json({ results: [{ title: "T", url: "https://t.com", content: "snippet" }] });
      }),
    );
    const out = await research("x");
    expect(out.providersFailed).toEqual(["brave"]);
    expect(out.providersUsed).toEqual(["tavily"]);
    expect(out.results).toHaveLength(1);
  });

  it("returns an empty, honest outcome when every provider fails", async () => {
    vi.stubEnv("EXA_API_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 503 })));
    const out = await research("x");
    expect(out.results).toEqual([]);
    expect(out.note).toBe("No usable sources were found.");
  });
});
