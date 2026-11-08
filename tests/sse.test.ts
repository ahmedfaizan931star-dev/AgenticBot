import { describe, expect, it } from "vitest";
import { chunksToEvents, parseSse } from "@/lib/llm/sse";

function streamOf(parts: string[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}
async function collect<T>(it: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("parseSse", () => {
  it("handles frames split across network chunks and stops at [DONE]", async () => {
    const body = streamOf(['data: {"a":', "1}\n\ndata: {", '"a":2}\n\n', "data: [DONE]\n\n", 'data: {"a":3}\n\n']);
    expect(await collect(parseSse(body))).toEqual([{ a: 1 }, { a: 2 }]);
  });
  it("skips malformed frames", async () => {
    expect(await collect(parseSse(streamOf(["data: nope\n\n", 'data: {"ok":true}\n\n'])))).toEqual([{ ok: true }]);
  });
});

describe("chunksToEvents", () => {
  const gen = async function* (items: unknown[]) {
    for (const i of items) yield i;
  };
  it("streams text then done", async () => {
    const ev = await collect(chunksToEvents(gen([{ choices: [{ delta: { content: "He" } }] }, { choices: [{ delta: { content: "llo" } }] }])));
    expect(ev).toEqual([{ type: "text", delta: "He" }, { type: "text", delta: "llo" }, { type: "done" }]);
  });
  it("assembles tool calls from fragments and fills missing ids", async () => {
    const ev = await collect(
      chunksToEvents(
        gen([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: '{"que' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"x"}' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ function: { name: "recall", arguments: "{}" } }] } }] },
        ]),
      ),
    );
    const calls = ev.find((e) => e.type === "tool_calls");
    expect(calls && calls.type === "tool_calls" && calls.calls[0]).toMatchObject({ id: "c1", function: { name: "web_search", arguments: '{"query":"x"}' } });
    expect(calls && calls.type === "tool_calls" && calls.calls[1]!.id).toMatch(/^call_/);
  });
});
