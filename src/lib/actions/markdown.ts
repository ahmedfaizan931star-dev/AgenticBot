const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

/** Minimal, safe Markdown to HTML for Google Docs import: everything is escaped first, then a few patterns are re-enabled. */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      out.push(`<pre>${esc(code.join("\n"))}</pre>`);
    } else if (h) {
      out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`);
      i++;
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i]!)) items.push(`<li>${inline(lines[i++]!.replace(/^\s*([-*]|\d+\.)\s/, ""))}</li>`);
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
    } else if (line.trim() === "") i++;
    else {
      const para: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.startsWith("```") && !/^#{1,3}\s/.test(lines[i]!) && !/^\s*([-*]|\d+\.)\s/.test(lines[i]!)) para.push(inline(lines[i++]!));
      out.push(`<p>${para.join("<br>")}</p>`);
    }
  }
  return `<html><body>${out.join("")}</body></html>`;
}
