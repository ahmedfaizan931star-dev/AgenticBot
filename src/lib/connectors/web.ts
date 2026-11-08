import "server-only";
import { fetchPages } from "@/lib/research/pages";
import { validateBrowserUrl, wrapUntrusted } from "@/lib/security/url";
import { pageText, type ToolOutput } from "./page";

/** Reads a public web page through the search providers' fetchers. The server itself never requests the URL. */
export async function readWebpage(url: unknown, offset: unknown): Promise<ToolOutput> {
  const v = validateBrowserUrl(url);
  if (!v.ok) return { ok: false, text: v.reason };
  const pages = await fetchPages([v.url], 40_000);
  const text = pages[0]?.text;
  if (!text) return { ok: false, text: "Could not read that page (it may block readers, need a login, or no reader key is configured)." };
  const { chunk, header } = pageText(text, offset);
  return { ok: true, text: wrapUntrusted("page_content", `${v.url}\n${header}\n\n${chunk}`, 13000), summary: new URL(v.url).hostname };
}
