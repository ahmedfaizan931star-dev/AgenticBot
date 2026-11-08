import "server-only";
import { persistMessage, touchChat } from "@/lib/agent/chat-store";
import type { StreamEvent } from "@/lib/agent/events";
import { COST, refund } from "@/lib/credits";
import { streamCompletion } from "@/lib/llm/provider";
import type { ChatMessage } from "@/lib/llm/types";
import { mergeResults, research, type SearchResult } from "@/lib/research";
import { fetchPages } from "@/lib/research/pages";
import { wrapUntrusted } from "@/lib/security/url";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";
import { PLAN_SYSTEM, WRITE_SYSTEM, parsePlan, sourcesBlock, sourcesSection, type Source } from "./plan";

type JobPatch = Omit<Database["public"]["Tables"]["research_jobs"]["Update"], "locked_until" | "updated_at">;
const LOCK_MS = 90_000;
const MAX_SOURCES = 12;

async function complete(messages: ChatMessage[], onText?: (d: string) => void): Promise<string> {
  let text = "";
  for await (const ev of streamCompletion({ messages, tools: [] })) {
    if (ev.type === "text") {
      text += ev.delta;
      onText?.(ev.delta);
    }
  }
  return text;
}

export async function* runResearchStep(userId: string, jobId: string): AsyncGenerator<StreamEvent> {
  const db = createAdminClient();
  const { data: job } = await db.from("research_jobs").select("*").eq("id", jobId).eq("user_id", userId).maybeSingle();
  if (!job) return yield { type: "error", code: "not_found", message: "Research job not found." };
  if (job.phase === "done" || job.phase === "failed") return yield { type: "research_progress", jobId, phase: job.phase };

  // Only one step may run at a time per job.
  const now = new Date();
  const { data: claimed } = await db
    .from("research_jobs")
    .update({ locked_until: new Date(now.getTime() + LOCK_MS).toISOString() })
    .eq("id", jobId)
    .eq("user_id", userId)
    .or(`locked_until.is.null,locked_until.lt.${now.toISOString()}`)
    .select("id");
  if (!claimed || claimed.length === 0) return yield { type: "error", code: "busy", message: "This research is already running." };

  const release = (patch: JobPatch = {}) =>
    db.from("research_jobs").update({ ...patch, locked_until: null, updated_at: new Date().toISOString() }).eq("id", jobId).eq("user_id", userId);

  const fail = async (message: string, userMessage: string) => {
    await release({ phase: "failed", error: message });
    await persistMessage(job.chat_id, userId, { role: "assistant", content: userMessage });
    await refund(userId, `job:${jobId}`);
    await touchChat(job.chat_id, userId);
  };

  try {
    if (job.phase === "plan") {
      yield { type: "research_progress", jobId, phase: "plan", detail: "Planning the search" };
      let queries: string[];
      try {
        const reply = await complete([
          { role: "system", content: PLAN_SYSTEM },
          { role: "user", content: `Question: ${job.question}\nToday: ${new Date().toISOString().slice(0, 10)}` },
        ]);
        queries = parsePlan(reply, job.question);
      } catch {
        queries = parsePlan("", job.question);
      }
      await release({ phase: "search", queries });
      yield { type: "research_progress", jobId, phase: "search", detail: `${queries.length} searches planned` };
      return;
    }

    if (job.phase === "search") {
      yield { type: "research_progress", jobId, phase: "search", detail: "Searching" };
      const outcomes = await Promise.all(job.queries.map((q) => research(q, 6)));
      const merged: SearchResult[] = mergeResults(outcomes.map((o) => o.results), MAX_SOURCES);
      if (merged.length === 0) {
        await fail("no_sources", "I could not find usable sources for this question, so I did not write a report. Your credits were returned. Try rephrasing or narrowing the question.");
        return yield { type: "research_progress", jobId, phase: "failed" };
      }
      const sources: Source[] = merged.map((r, i) => ({ n: i + 1, title: r.title, url: r.url, snippet: r.snippet }));
      await release({ phase: "read", sources });
      return yield { type: "research_progress", jobId, phase: "read", detail: `${sources.length} sources found` };
    }

    if (job.phase === "read") {
      yield { type: "research_progress", jobId, phase: "read", detail: "Reading sources" };
      const sources = job.sources as Source[];
      const pages = await fetchPages(sources.slice(0, 8).map((s) => s.url));
      const byUrl = new Map(pages.map((p) => [p.url, p.text]));
      const withText = sources.map((s) => ({ ...s, text: byUrl.get(s.url) }));
      await release({ phase: "write", sources: withText });
      return yield { type: "research_progress", jobId, phase: "write", detail: `Read ${pages.length} pages` };
    }

    if (job.phase === "write") {
      yield { type: "research_progress", jobId, phase: "write", detail: "Writing the report" };
      const sources = job.sources as Source[];
      const prompt = `Question: ${job.question}\n\n${wrapUntrusted("search_results", sourcesBlock(sources), 40000)}`;
      let report = "";
      try {
        const stream = streamCompletion({ messages: [{ role: "system", content: WRITE_SYSTEM }, { role: "user", content: prompt }], tools: [] });
        for await (const ev of stream) {
          if (ev.type === "text") {
            report += ev.delta;
            yield { type: "text", delta: ev.delta };
          }
        }
      } catch {
        await release(); // phase stays "write" so the client can retry without paying again
        return yield { type: "error", code: "model_unavailable", message: "The model is unavailable. Tap retry in a moment." };
      }
      if (report.trim().length === 0) {
        await release();
        return yield { type: "error", code: "empty", message: "The model returned nothing. Tap retry." };
      }
      const full = report.trim() + sourcesSection(sources);
      yield { type: "text", delta: sourcesSection(sources) };
      await persistMessage(job.chat_id, userId, { role: "assistant", content: full });
      await release({ phase: "done" });
      await touchChat(job.chat_id, userId);
      return yield { type: "research_progress", jobId, phase: "done" };
    }
  } catch {
    await release();
    yield { type: "error", code: "server", message: "Something went wrong. Tap retry." };
  }
}

export const DEEP_COST = COST.deepResearch;
