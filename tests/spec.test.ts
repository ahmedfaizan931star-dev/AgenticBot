import { describe, expect, it } from "vitest";
import { AGENT_BRANCH_RE, describeWrite, isWriteTool, writablePath } from "@/lib/actions/spec";
import { markdownToHtml } from "@/lib/actions/markdown";

describe("agent branch rule", () => {
  it("only allows agent/<name> branches", () => {
    for (const ok of ["agent/fix-login", "agent/a.b_c-1"]) expect(AGENT_BRANCH_RE.test(ok)).toBe(true);
    for (const bad of ["main", "master", "release/1.0", "agent/", "agent", "agent/../main", "agent/a b", "feature/agent/x", "agent/x/y"]) {
      expect(AGENT_BRANCH_RE.test(bad) && !bad.includes("..")).toBe(false);
    }
  });
});

describe("writablePath", () => {
  it("blocks CI definitions, .git and traversal", () => {
    for (const bad of [".github/workflows/ci.yml", ".GitHub/workflows/x.yml", "a/.git/config", "../x", "a/../b", "", "x\u0000y"]) expect(writablePath(bad)).toBeNull();
    expect(writablePath("src/a b.ts")).toBe("src/a%20b.ts");
  });
});

describe("describeWrite", () => {
  it("accepts a valid commit and describes it for the approval card", () => {
    const r = describeWrite("github_commit_file", { repo: "o/r", path: "docs/a.md", content: "hello", message: "Add docs", branch: "agent/docs" });
    expect(r.ok && r.value.summary).toContain("agent/docs");
    expect(r.ok && r.value.preview).toBe("hello");
  });
  it("rejects writes to the default branch, workflows, extra fields and bad repos", () => {
    const base = { repo: "o/r", path: "a.md", content: "x", message: "m", branch: "agent/x" };
    expect(describeWrite("github_commit_file", { ...base, branch: "main" }).ok).toBe(false);
    expect(describeWrite("github_commit_file", { ...base, path: ".github/workflows/x.yml" }).ok).toBe(false);
    expect(describeWrite("github_commit_file", { ...base, extra: 1 }).ok).toBe(false);
    expect(describeWrite("github_commit_file", { ...base, repo: "../x" }).ok).toBe(false);
    expect(describeWrite("github_open_pr", { repo: "o/r", title: "t", head: "main" }).ok).toBe(false);
  });
  it("limits sizes and label counts", () => {
    expect(describeWrite("github_create_issue", { repo: "o/r", title: "t", body: "x".repeat(20001) }).ok).toBe(false);
    expect(describeWrite("github_create_issue", { repo: "o/r", title: "t", labels: ["a", "b", "c", "d", "e", "f"] }).ok).toBe(false);
    expect(describeWrite("drive_create_doc", { title: "T", content: "" }).ok).toBe(false);
  });
  it("truncates long previews but keeps the full content in args", () => {
    const r = describeWrite("drive_create_doc", { title: "T", content: "y".repeat(5000) });
    expect(r.ok && r.value.preview!.length).toBeLessThan(1700);
    expect(r.ok && (r.value.args.content as string).length).toBe(5000);
  });
  it("knows which tools are write tools", () => {
    expect(isWriteTool("github_open_pr")).toBe(true);
    expect(isWriteTool("github_merge_pr")).toBe(false);
    expect(isWriteTool("github_delete_file")).toBe(false);
  });
});

describe("markdownToHtml", () => {
  it("escapes raw HTML and scripts", () => {
    const h = markdownToHtml("# Hi <script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
    expect(h).not.toContain("<script>");
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;script&gt;");
  });
  it("renders headings, lists, bold, code and only http(s) links", () => {
    const h = markdownToHtml("## T\n\n- a\n- **b**\n\n[ok](https://x.com) [bad](javascript:alert(1))\n\n```\ncode <b>\n```");
    expect(h).toContain("<h2>T</h2>");
    expect(h).toContain("<ul><li>a</li><li><b>b</b></li></ul>");
    expect(h).toContain('<a href="https://x.com">ok</a>');
    expect(h).not.toContain('href="javascript');
    expect(h).toContain("<pre>code &lt;b&gt;</pre>");
  });
});
