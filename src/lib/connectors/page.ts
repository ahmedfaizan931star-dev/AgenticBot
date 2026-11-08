export const PAGE_CHARS = 12000;

export type ToolOutput = { ok: boolean; text: string; summary?: string };

/** Returns one window of a long text plus a hint for fetching the next one. */
export function pageText(text: string, offset: unknown, limit = PAGE_CHARS): { chunk: string; header: string } {
  const start = typeof offset === "number" && Number.isInteger(offset) && offset > 0 ? Math.min(offset, text.length) : 0;
  const chunk = text.slice(start, start + limit);
  const end = start + chunk.length;
  const header =
    end < text.length
      ? `[characters ${start}-${end} of ${text.length}; call again with offset ${end} for more]`
      : `[characters ${start}-${end} of ${text.length}; end of file]`;
  return { chunk, header };
}
