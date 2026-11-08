import { afterEach, describe, expect, it, vi } from "vitest";
import { streamCompletion } from "@/lib/llm/provider";
import type { LlmEvent } from "@/lib/llm/types";

const sse = (...frames: unknown[]) =>
  new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });

async function collect(gen: AsyncIterable<LlmEvent>) {
  const out: LlmEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("streamCompletion", () => {
  it("falls back to the next provider when the first fails before output", async () => {
    vi.stubEnv("GEMINI_API_KEY", "g");
    vi.stubEnv("OPENROUTER_API_KEY", "o");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return url.includes("googleapis") ? new Response("overloaded", { status: 503 }) : sse({ choices: [{ delta: { content: "hi" } }] });
      }),
    );
    const ev = await collect(streamCompletion({ messages: [{ role: "user", content: "x" }], tools: [] }));
    expect(ev).toEqual([{ type: "text", delta: "hi" }, { type: "done" }]);
    expect(calls).toHaveLength(2);
  });

  it("throws when every provider fails and when none is configured", async () => {
    vi.stubEnv("GEMINI_API_KEY", "g");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    await expect(collect(streamCompletion({ messages: [], tools: [] }))).rejects.toThrow();
    vi.stubEnv("GEMINI_API_KEY", "");
    await expect(collect(streamCompletion({ messages: [], tools: [] }))).rejects.toThrow(/No model provider/);
  });
});
