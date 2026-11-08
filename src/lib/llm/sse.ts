import type { LlmEvent, ToolCall } from "./types";

/** Parses an OpenAI-style SSE body into JSON chunks. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
        const payload = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!payload) continue;
        if (payload === "[DONE]") return;
        try {
          yield JSON.parse(payload);
        } catch {
          // ignore malformed keep-alive frames
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

type Delta = {
  content?: string | null;
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
};

/** Turns raw chat-completion chunks into text deltas and, at the end, complete tool calls. */
export async function* chunksToEvents(chunks: AsyncIterable<unknown>): AsyncGenerator<LlmEvent> {
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let lastIndex = -1;
  for await (const chunk of chunks) {
    const choice = (chunk as { choices?: { delta?: Delta }[] }).choices?.[0];
    const delta = choice?.delta;
    if (!delta) continue;
    if (typeof delta.content === "string" && delta.content.length > 0) yield { type: "text", delta: delta.content };
    for (const tc of delta.tool_calls ?? []) {
      // Some providers (Gemini's compatibility endpoint) omit `index`: a chunk carrying an id or name then starts a new call.
      const index = typeof tc.index === "number" ? tc.index : tc.id || tc.function?.name ? calls.size : Math.max(lastIndex, 0);
      lastIndex = index;
      const cur = calls.get(index) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(index, cur);
    }
  }
  if (calls.size > 0) {
    const out: ToolCall[] = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, c]) => c.name)
      .map(([i, c]) => ({
        id: c.id || `call_${Date.now().toString(36)}_${i}`,
        type: "function" as const,
        function: { name: c.name, arguments: c.args || "{}" },
      }));
    if (out.length > 0) yield { type: "tool_calls", calls: out };
  }
  yield { type: "done" };
}
