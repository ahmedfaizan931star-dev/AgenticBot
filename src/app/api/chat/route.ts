import { z } from "zod";
import { runAgent, type RunInput } from "@/lib/agent/run";
import { allow } from "@/lib/ratelimit";
import { isSameOrigin } from "@/lib/security/url";
import { createClient } from "@/lib/supabase/server";
import type { StreamEvent } from "@/lib/agent/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const common = { mode: z.enum(["chat", "research"]).default("chat"), extension: z.boolean().default(false) };
const bodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), chatId: z.string().uuid().optional(), content: z.string().trim().min(1).max(20000), attachments: z.array(z.string().uuid()).max(5).default([]), ...common }),
  z.object({ kind: z.literal("continue"), chatId: z.string().uuid(), ...common }),
  z.object({
    kind: z.literal("tool_results"),
    chatId: z.string().uuid(),
    results: z
      .array(z.object({ toolCallId: z.string().min(1).max(200), content: z.string().max(60000), isError: z.boolean().default(false) }))
      .min(1)
      .max(8),
    ...common,
  }),
]);

const json = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return json(403, "forbidden", "Cross-site request blocked.");

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) return json(401, "unauthorized", "Please sign in.");

  if (!(await allow(`chat:${user.id}`, 30, 60))) return json(429, "rate_limited", "Too many requests. Wait a moment.");

  let parsed;
  try {
    parsed = bodySchema.safeParse(await request.json());
  } catch {
    return json(400, "bad_request", "Invalid JSON.");
  }
  if (!parsed.success) return json(400, "bad_request", "Invalid request.");

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: StreamEvent) => controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
      try {
        for await (const ev of runAgent(user.id, parsed.data as RunInput, request.signal)) send(ev);
      } catch {
        send({ type: "error", code: "server", message: "Something went wrong." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
