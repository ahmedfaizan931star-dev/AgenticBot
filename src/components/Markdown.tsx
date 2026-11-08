import type { ReactNode } from "react";

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>)\]]+)/g;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("`")) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("[")) {
      const close = tok.indexOf("](");
      out.push(
        <a key={key} href={tok.slice(close + 2, -1)} target="_blank" rel="noopener noreferrer nofollow">
          {tok.slice(1, close)}
        </a>,
      );
    } else {
      out.push(
        <a key={key} href={tok} target="_blank" rel="noopener noreferrer nofollow">
          {tok}
        </a>,
      );
    }
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Small, safe renderer: builds React nodes only, never raw HTML. Links are http(s) only. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      blocks.push(
        <pre key={k++}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
    } else if (/^#{1,3}\s/.test(line)) {
      blocks.push(<h4 key={k++}>{inline(line.replace(/^#{1,3}\s/, ""), `h${k}`)}</h4>);
      i++;
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i]!)) {
        items.push(<li key={items.length}>{inline(lines[i]!.replace(/^\s*([-*]|\d+\.)\s/, ""), `li${k}-${items.length}`)}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>);
    } else if (line.trim() === "") {
      i++;
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.startsWith("```") && !/^#{1,3}\s/.test(lines[i]!) && !/^\s*([-*]|\d+\.)\s/.test(lines[i]!)) {
        para.push(lines[i++]!);
      }
      blocks.push(<p key={k++}>{inline(para.join("\n"), `p${k}`)}</p>);
    }
  }
  return <div className="md">{blocks}</div>;
}
