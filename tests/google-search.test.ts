import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ allowResults: [] as boolean[] }));
vi.mock("@/lib/ratelimit", () => ({ allow: async () => (h.allowResults.length ? h.allowResults.shift()! : true) }));

import { googleSearch, groundingEnabled, parseGrounded } from "@/lib/search/google";

const response = {
  candidates: [
    {
      content: { parts: [{ text: "The answer is 42." }] },
      groundingMetadata: {
        webSearchQueries: ["q"],
        groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/a", title: "a.com" } }, { web: { uri: "https://vertexaisearch.cloud.google.com/a", title: "dup" } }, { web: { uri: "http://insecure.example/x", title: "bad" } }, { web: { uri: "https://b.com/p", title: "b.com" } }],
        searchEntryPoint: { renderedContent: "<div>suggest</div>" },
      },
    },
  ],
};

beforeEach(() => {
  h.allowResults = [];
  vi.stubEnv("GEMINI_API_KEY", "k");
  vi.stubEnv("GOOGLE_GROUNDING_ENABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("parseGrounded", () => {
  it("extracts answer, de-duplicated https sources and the suggestions html", () => {
    const p = parseGrounded(response);
    expect(p.answer).toBe("The answer is 42.");
    expect(p.sources.map((s) => s.uri)).toEqual(["https://vertexaisearch.cloud.google.com/a", "https://b.com/p"]);
    expect(p.html).toBe("<div>suggest</div>");
  });
  it("drops oversized suggestion markup and tolerates empty responses", () => {
    const big = { candidates: [{ groundingMetadata: { searchEntryPoint: { renderedContent: "x".repeat(30_001) } } }] };
    expect(parseGrounded(big).html).toBeUndefined();
    expect(parseGrounded({})).toMatchObject({ answer: "", sources: [] });
  });
});

describe("googleSearch", () => {
  it("is off unless explicitly enabled", async () => {
    vi.stubEnv("GOOGLE_GROUNDING_ENABLED", "false");
    expect(groundingEnabled()).toBe(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await googleSearch("u", "x")).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns wrapped, untrusted results plus the suggestions to display, with the key in a header", async () => {
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);
    const out = await googleSearch("u", "meaning of life");
    expect(out.ok).toBe(true);
    expect(out.text.startsWith("<untrusted_search_results>")).toBe(true);
    expect(out.suggestionsHtml).toBe("<div>suggest</div>");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("key=");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    expect(JSON.parse(String(init.body)).tools).toEqual([{ google_search: {} }]);
  });

  it("stops at the daily caps without calling Google", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    h.allowResults = [false];
    expect((await googleSearch("u", "x")).text).toMatch(/today's limit/);
    h.allowResults = [true, false];
    expect((await googleSearch("u", "x")).text).toMatch(/your|today/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails softly on HTTP errors so the agent can fall back to web_search", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("quota", { status: 429 })));
    const out = await googleSearch("u", "x");
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/web_search/);
  });
});
