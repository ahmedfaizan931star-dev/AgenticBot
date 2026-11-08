import { z } from "zod";
import { REF_RE, REPO_RE, safePath } from "@/lib/connectors/github";

export const WRITE_TOOL_NAMES = ["github_create_issue", "github_comment", "github_commit_file", "github_open_pr", "drive_create_doc"] as const;
export type WriteTool = (typeof WRITE_TOOL_NAMES)[number];
export const isWriteTool = (name: string): name is WriteTool => (WRITE_TOOL_NAMES as readonly string[]).includes(name);
export const providerOf = (tool: WriteTool): "github" | "google" => (tool.startsWith("github_") ? "github" : "google");

/** The agent may only write to branches it creates itself, under this prefix. It can never touch the default branch. */
export const AGENT_BRANCH_RE = /^agent\/[A-Za-z0-9._-]{1,80}$/;
const branch = z.string().regex(AGENT_BRANCH_RE, "Branch must look like agent/<name>").refine((b) => !b.includes("..") && !b.endsWith(".lock") && !b.endsWith("."), "Invalid branch name");
const repo = z.string().regex(REPO_RE, "Use owner/name");
const longText = (max: number) => z.string().max(max);

/** CI/CD definitions could be rewritten to exfiltrate secrets, so these paths are never writable. */
export function writablePath(path: string): string | null {
  const encoded = safePath(path);
  if (!encoded) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === ".git")) return null;
  if (parts[0]?.toLowerCase() === ".github") return null;
  return encoded;
}

const schemas = {
  github_create_issue: z.object({ repo, title: z.string().trim().min(1).max(256), body: longText(20000).default(""), labels: z.array(z.string().trim().min(1).max(50)).max(5).optional() }).strict(),
  github_comment: z.object({ repo, number: z.number().int().min(1).max(1_000_000_000), body: z.string().trim().min(1).max(20000) }).strict(),
  github_commit_file: z
    .object({
      repo,
      path: z.string().min(1).max(300).refine((p) => writablePath(p) !== null, "Path is not writable"),
      content: longText(200_000),
      message: z.string().trim().min(1).max(200),
      branch,
    })
    .strict(),
  github_open_pr: z.object({ repo, title: z.string().trim().min(1).max(256), head: branch, base: z.string().regex(REF_RE).optional(), body: longText(20000).default("") }).strict(),
  drive_create_doc: z.object({ title: z.string().trim().min(1).max(200), content: z.string().min(1).max(100_000) }).strict(),
} as const;

export type Described = { args: Record<string, unknown>; summary: string; preview: string | null };

const clip = (s: string, n = 1500) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

export function describeWrite(tool: WriteTool, raw: unknown): { ok: true; value: Described } | { ok: false; error: string } {
  const parsed = schemas[tool].safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid arguments" };
  const a = parsed.data as Record<string, unknown> & { repo?: string };
  let summary: string;
  let preview: string | null = null;
  switch (tool) {
    case "github_create_issue":
      summary = `Create an issue in ${a.repo}: ${a.title}`;
      preview = clip(String(a.body ?? "")) || null;
      break;
    case "github_comment":
      summary = `Comment on ${a.repo}#${a.number}`;
      preview = clip(String(a.body));
      break;
    case "github_commit_file":
      summary = `Write ${a.path} on new branch ${a.branch} in ${a.repo} (commit: ${String(a.message).slice(0, 80)})`;
      preview = clip(String(a.content));
      break;
    case "github_open_pr":
      summary = `Open a pull request in ${a.repo}: ${a.head} into ${a.base ?? "the default branch"}: ${a.title}`;
      preview = clip(String(a.body ?? "")) || null;
      break;
    case "drive_create_doc":
      summary = `Create a new Google Doc titled "${a.title}" in your Drive`;
      preview = clip(String(a.content));
      break;
  }
  return { ok: true, value: { args: parsed.data as Record<string, unknown>, summary, preview } };
}
