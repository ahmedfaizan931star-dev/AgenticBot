import "server-only";
import { providerSafeSchema } from "@/lib/mcp/registry";
import { chunksToEvents, parseSse } from "./sse";
import type { ChatMessage, LlmEvent, ToolDef } from "./types";

type Provider = { name: string; baseUrl: string; apiKey: string; model: string; extraHeaders?: Record<string, string> };

export function configuredProviders(): Provider[] {
  const list: Provider[] = [];
  if (process.env.GEMINI_API_KEY) {
    list.push({
      name: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    });
  }
  if (process.env.OPENROUTER_API_KEY) {
    list.push({
      name: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash",
    });
  }
  return list;
}

export class NoProviderError extends Error {
  constructor() {
    super("No model provider is available");
  }
}

const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Streams a completion. If a provider fails before producing any output, the next one is tried.
 * Once output has started, a failure is surfaced instead of silently restarting.
 */
export async function* streamCompletion(opts: {
  messages: ChatMessage[];
  tools: ToolDef[];
  signal?: AbortSignal;
}): AsyncGenerator<LlmEvent> {
  const providers = configuredProviders();
  if (providers.length === 0) throw new NoProviderError();
  let lastError: unknown;

  for (const p of providers) {
    let started = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
      opts.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
      const res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}`, ...p.extraHeaders },
        body: JSON.stringify({
          model: p.model,
          messages: opts.messages,
          stream: true,
          ...(opts.tools.length > 0 ? { tools: p.name === "gemini" ? opts.tools.map((t) => ({ ...t, function: { ...t.function, parameters: providerSafeSchema(t.function.parameters) } })) : opts.tools, tool_choice: "auto" } : {}),
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok || !res.body) throw new Error(`${p.name} responded ${res.status}`);
      for await (const ev of chunksToEvents(parseSse(res.body))) {
        started = true;
        yield ev;
      }
      return;
    } catch (err) {
      lastError = err;
      if (started) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All model providers failed");
}
