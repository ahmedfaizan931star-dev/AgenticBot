import { describe, expect, it } from "vitest";
import { cleanFileName, extractFromBuffer } from "@/lib/files/extract";
import { inspectZip } from "@/lib/files/zip";
import { pageText } from "@/lib/connectors/page";
import { makeDocx, makePdf, makeZip } from "./helpers";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("inspectZip", () => {
  it("reads entry count and claimed uncompressed size without inflating", () => {
    const z = inspectZip(makeZip([{ name: "a.txt", data: "hello" }, { name: "b.txt", data: "world!" }]));
    expect(z).toEqual({ ok: true, entries: 2, uncompressed: 11 });
  });
  it("rejects garbage", () => expect(inspectZip(bytes("not a zip at all, just text"))).toEqual({ ok: false }));
});

describe("extractFromBuffer", () => {
  it("reads plain text and strips carriage returns", async () => {
    const r = await extractFromBuffer("notes.md", bytes("# Title\r\nbody"));
    expect(r).toMatchObject({ ok: true, text: "# Title\nbody" });
  });
  it("rejects binary data posing as text, unknown types and empty files", async () => {
    expect((await extractFromBuffer("a.txt", new Uint8Array([104, 105, 0, 1, 2]))).ok).toBe(false);
    expect((await extractFromBuffer("a.exe", bytes("MZ hello"))).ok).toBe(false);
    expect((await extractFromBuffer("a.txt", new Uint8Array())).ok).toBe(false);
  });
  it("rejects invalid UTF-8", async () => expect((await extractFromBuffer("a.txt", new Uint8Array([0xff, 0xfe, 0xfa]))).ok).toBe(false));
  it("enforces the size limit", async () => expect((await extractFromBuffer("a.txt", new Uint8Array(4 * 1024 * 1024 + 1).fill(97))).ok).toBe(false));
  it("trusts content over extension: a zip renamed .txt is refused", async () => {
    expect((await extractFromBuffer("sneaky.txt", makeZip([{ name: "x", data: "y" }]))).ok).toBe(false);
  });
  it("extracts text from a real PDF", async () => {
    const r = await extractFromBuffer("doc.pdf", makePdf("Hello PDF world"));
    expect(r.ok && r.text).toContain("Hello PDF world");
  });
  it("extracts text from a real DOCX", async () => {
    const r = await extractFromBuffer("doc.docx", makeDocx("Quarterly report text"));
    expect(r.ok && r.text).toContain("Quarterly report text");
  });
  it("refuses a DOCX whose archive claims a huge uncompressed size (zip bomb)", async () => {
    const r = await extractFromBuffer("bomb.docx", makeDocx("x", 900 * 1024 * 1024));
    expect(r.ok).toBe(false);
  });
  it("refuses a .zip that is not a docx", async () => expect((await extractFromBuffer("a.zip", makeZip([{ name: "x", data: "y" }]))).ok).toBe(false));
  it("caps extracted text", async () => {
    const r = await extractFromBuffer("big.txt", bytes("a".repeat(3 * 1024 * 1024)));
    expect(r.ok && r.text.length).toBe(300_000);
  });
});

describe("cleanFileName", () => {
  it("drops paths, control characters and angle brackets", () => {
    expect(cleanFileName("..\\..\\evil\n<script>.pdf")).toBe("evilscript.pdf");
    expect(cleanFileName("a/b/c report.pdf")).toBe("c report.pdf");
    expect(cleanFileName("\u0000\u0001")).toBe("file");
    expect(cleanFileName("x".repeat(500)).length).toBe(80);
  });
});

describe("pageText", () => {
  const t = "0123456789".repeat(3);
  it("pages through long text and says where the end is", () => {
    const a = pageText(t, undefined, 10);
    expect(a.chunk).toBe("0123456789");
    expect(a.header).toContain("offset 10");
    const c = pageText(t, 20, 10);
    expect(c.header).toContain("end of file");
  });
  it("ignores bad offsets", () => {
    expect(pageText(t, -5, 5).chunk).toBe("01234");
    expect(pageText(t, "x", 5).chunk).toBe("01234");
    expect(pageText(t, 999, 5).chunk).toBe("");
  });
});
