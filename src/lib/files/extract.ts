import "server-only";
import { inspectZip } from "./zip";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // Vercel functions reject request bodies above ~4.5 MB
export const MAX_TEXT_CHARS = 300_000;
const MAX_PDF_PAGES = 300;
const MAX_ZIP_UNCOMPRESSED = 60 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 3000;

export type Extracted = { ok: true; mime: string; text: string } | { ok: false; reason: string };

const TEXT_EXT = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "log", "yaml", "yml", "xml", "html", "ts", "tsx", "js", "jsx", "py", "sql", "css"]);

export const ext = (name: string) => (name.split(".").pop() ?? "").toLowerCase();

const startsWith = (b: Uint8Array, s: string) => s.split("").every((c, i) => b[i] === c.charCodeAt(0));

/** Decodes strict UTF-8 and rejects binary data. */
export function decodeText(buf: Uint8Array): string | null {
  if (buf.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

export async function extractDocxText(buf: Uint8Array): Promise<Extracted> {
  const zip = inspectZip(buf);
  if (!zip.ok) return { ok: false, reason: "This DOCX file is damaged." };
  if (zip.uncompressed > MAX_ZIP_UNCOMPRESSED || zip.entries > MAX_ZIP_ENTRIES) return { ok: false, reason: "This DOCX file is too large when opened." };
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
  return { ok: true, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", text: value };
}

export async function extractPdfText(buf: Uint8Array): Promise<Extracted> {
  if (!startsWith(buf, "%PDF-")) return { ok: false, reason: "This is not a valid PDF." };
  const { getDocumentProxy, extractText } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  if (pdf.numPages > MAX_PDF_PAGES) return { ok: false, reason: `PDFs over ${MAX_PDF_PAGES} pages are not supported.` };
  const { text } = await extractText(pdf, { mergePages: true });
  return { ok: true, mime: "application/pdf", text: Array.isArray(text) ? text.join("\n") : text };
}

/** Detects the real type from content (not just the extension) and returns plain text. */
export async function extractFromBuffer(name: string, buf: Uint8Array, maxBytes = MAX_UPLOAD_BYTES): Promise<Extracted> {
  if (buf.length === 0) return { ok: false, reason: "The file is empty." };
  if (buf.length > maxBytes) return { ok: false, reason: `The file is larger than ${Math.round(maxBytes / 1048576)} MB.` };
  const e = ext(name);
  let result: Extracted;
  try {
    if (startsWith(buf, "%PDF-")) result = await extractPdfText(buf);
    else if (startsWith(buf, "PK\u0003\u0004")) {
      result = e === "docx" ? await extractDocxText(buf) : { ok: false, reason: "Only .docx archives are supported." };
    } else if (TEXT_EXT.has(e)) {
      const t = decodeText(buf);
      result = t === null ? { ok: false, reason: "This file is not readable text." } : { ok: true, mime: "text/plain", text: t };
    } else {
      result = { ok: false, reason: "Unsupported file type. Use PDF, DOCX, TXT, MD, CSV or JSON." };
    }
  } catch {
    return { ok: false, reason: "The file could not be read." };
  }
  if (!result.ok) return result;
  const text = result.text.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim().slice(0, MAX_TEXT_CHARS);
  if (text.length === 0) return { ok: false, reason: "No readable text was found (scanned PDFs are not supported yet)." };
  return { ok: true, mime: result.mime, text };
}

/** Filenames are user-controlled: strip control characters and path parts before they reach the model. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "file";
}
