import "server-only";
import { allow } from "@/lib/ratelimit";
import { isSameOrigin } from "@/lib/security/url";
import { createClient } from "@/lib/supabase/server";

export const err = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });

/** Shared guard for authenticated JSON endpoints: origin check (for writes), session, rate limit. */
export async function guard(request: Request, opts: { write: boolean; bucket: string; limit: number; windowSeconds: number }) {
  if (opts.write && !isSameOrigin(request)) return { response: err(403, "forbidden", "Cross-site request blocked.") };
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { response: err(401, "unauthorized", "Please sign in.") };
  if (!(await allow(`${opts.bucket}:${data.user.id}`, opts.limit, opts.windowSeconds))) {
    return { response: err(429, "rate_limited", "Too many requests. Wait a moment.") };
  }
  return { user: data.user };
}

export function ndjson(gen: AsyncGenerator<unknown>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of gen) controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
      } catch {
        controller.enqueue(encoder.encode(JSON.stringify({ type: "error", code: "server", message: "Something went wrong." }) + "\n"));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
