import { describe, expect, it } from "vitest";
import { parsePlan, sourcesBlock, sourcesSection } from "@/lib/deep/plan";

describe("parsePlan", () => {
  it("reads a clean JSON array", () => expect(parsePlan('["a","b"]', "q")).toEqual(["a", "b"]));
  it("tolerates code fences and surrounding prose", () => {
    expect(parsePlan('Sure!\n```json\n["x y", "z"]\n```', "q")).toEqual(["x y", "z"]);
  });
  it("dedupes, drops non-strings and caps at five", () => {
    expect(parsePlan('["a","a",1,null,"b","c","d","e","f"]', "q")).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("falls back to the question on garbage, empty arrays or malformed JSON", () => {
    expect(parsePlan("no json here", "my question")).toEqual(["my question"]);
    expect(parsePlan("[]", "my question")).toEqual(["my question"]);
    expect(parsePlan("[unterminated", "my question")).toEqual(["my question"]);
  });
});

describe("sources", () => {
  const src = [{ n: 1, title: "Alpha", url: "https://a.com", snippet: "snip", text: "full text" }, { n: 2, title: "", url: "https://b.com", snippet: "only snippet" }];
  it("builds the appended list from real URLs only", () => {
    expect(sourcesSection(src)).toBe("\n\n## Sources\n1. [Alpha](https://a.com)\n2. [https://b.com](https://b.com)");
  });
  it("prefers page text over the snippet for the model", () => {
    const b = sourcesBlock(src);
    expect(b).toContain("full text");
    expect(b).toContain("only snippet");
  });
});
