import { z } from "zod";
import type { ToolDef } from "@/lib/llm/types";
import { validateBrowserUrl } from "@/lib/security/url";

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});

export const SERVER_TOOLS: ToolDef[] = [
  fn("web_search", "Search the web for current information. Returns titles, URLs and snippets from several providers.", {
    query: { type: "string", description: "Short, specific search query" },
  }, ["query"]),
  fn("remember", "Save one short fact about the user that they asked you to remember (max 500 chars).", {
    content: { type: "string" },
  }, ["content"]),
  fn("recall", "Look up the user's saved notes. Optional keyword filter.", { query: { type: "string" } }),
];

export const DRIVE_TOOLS: ToolDef[] = [
  fn("drive_search", "Search the user's Google Drive files by content or name. Returns file ids you can pass to drive_read.", { query: { type: "string" } }, ["query"]),
  fn("drive_read", "Read a Google Drive file as text (Docs, Sheets as CSV, Slides, PDF, DOCX, text files). Long files are paged with offset.", {
    fileId: { type: "string" },
    offset: { type: "integer", description: "Character offset for the next page" },
  }, ["fileId"]),
];

export const GITHUB_TOOLS: ToolDef[] = [
  fn("github_list_repos", "List the user's most recently pushed GitHub repositories.", {}),
  fn("github_search_code", "Search code on GitHub, optionally limited to one repo (owner/name).", {
    query: { type: "string" },
    repo: { type: "string", description: "owner/name" },
  }, ["query"]),
  fn("github_read_file", "Read a file or list a directory in a GitHub repo. Long files are paged with offset.", {
    repo: { type: "string", description: "owner/name" },
    path: { type: "string", description: "File or directory path; empty for the repo root" },
    ref: { type: "string", description: "Branch, tag or commit" },
    offset: { type: "integer" },
  }, ["repo"]),
  fn("github_list_issues", "List issues and pull requests of a repo.", {
    repo: { type: "string", description: "owner/name" },
    state: { type: "string", enum: ["open", "closed", "all"] },
  }, ["repo"]),
];

export const UPLOAD_TOOLS: ToolDef[] = [
  fn("read_upload", "Read a file the user uploaded in this conversation (see the [Attached files] note). Long files are paged with offset.", {
    fileId: { type: "string" },
    offset: { type: "integer" },
  }, ["fileId"]),
];

export const DRIVE_TOOL_NAMES = new Set(DRIVE_TOOLS.map((t) => t.function.name));
export const GITHUB_TOOL_NAMES = new Set(GITHUB_TOOLS.map((t) => t.function.name));

export const WEB_TOOLS: ToolDef[] = [
  fn("read_webpage", "Read a public web page as text (articles, docs, pricing pages). Long pages are paged with offset.", {
    url: { type: "string" },
    offset: { type: "integer" },
  }, ["url"]),
];

export const GOOGLE_SEARCH_TOOL: ToolDef = fn("google_search", "Search with Google (grounded, recent facts). Prefer it for breaking or local news; costs more than web_search.", { query: { type: "string" } }, ["query"]);

export const PLAN_TOOL: ToolDef = fn("update_plan", "Show the user your plan as a short checklist and keep it current. Use it for tasks with 3 or more steps; update statuses as you go.", {
  steps: {
    type: "array",
    maxItems: 10,
    items: { type: "object", properties: { text: { type: "string" }, status: { type: "string", enum: ["todo", "doing", "done"] } }, required: ["text", "status"], additionalProperties: false },
  },
}, ["steps"]);

export const GITHUB_WRITE_TOOLS: ToolDef[] = [
  fn("github_create_issue", "Propose creating a GitHub issue. The user must approve before anything happens.", {
    repo: { type: "string", description: "owner/name" },
    title: { type: "string" },
    body: { type: "string" },
    labels: { type: "array", items: { type: "string" } },
  }, ["repo", "title"]),
  fn("github_comment", "Propose a comment on an issue or pull request. The user must approve.", {
    repo: { type: "string" },
    number: { type: "integer" },
    body: { type: "string" },
  }, ["repo", "number", "body"]),
  fn("github_commit_file", "Propose writing one file on a NEW branch named agent/<name>. Never the default branch. The user must approve. Follow with github_open_pr.", {
    repo: { type: "string" },
    path: { type: "string" },
    content: { type: "string", description: "Full new file content" },
    message: { type: "string", description: "Commit message" },
    branch: { type: "string", description: "Must start with agent/" },
  }, ["repo", "path", "content", "message", "branch"]),
  fn("github_open_pr", "Propose opening a pull request from an agent/ branch. The user must approve. Merging is never allowed.", {
    repo: { type: "string" },
    title: { type: "string" },
    head: { type: "string", description: "agent/<name>" },
    base: { type: "string", description: "Defaults to the repo default branch" },
    body: { type: "string" },
  }, ["repo", "title", "head"]),
];

export const DRIVE_WRITE_TOOLS: ToolDef[] = [
  fn("drive_create_doc", "Propose creating a NEW Google Doc in the user's Drive from Markdown text. The user must approve. Existing files are never changed.", {
    title: { type: "string" },
    content: { type: "string", description: "Markdown: #, ##, lists, **bold**" },
  }, ["title", "content"]),
];

export const PLAN_STEP_SCHEMA = z.object({ steps: z.array(z.object({ text: z.string().trim().min(1).max(200), status: z.enum(["todo", "doing", "done"]) })).min(1).max(10) }).strict();

type Conn = { mode: "read" | "write" } | undefined;
export function serverToolsFor(connected: { google?: Conn; github?: Conn }, opts: { grounding?: boolean } = {}): ToolDef[] {
  return [
    ...SERVER_TOOLS,
    ...UPLOAD_TOOLS,
    ...WEB_TOOLS,
    PLAN_TOOL,
    ...(opts.grounding ? [GOOGLE_SEARCH_TOOL] : []),
    ...(connected.google ? DRIVE_TOOLS : []),
    ...(connected.google?.mode === "write" ? DRIVE_WRITE_TOOLS : []),
    ...(connected.github ? GITHUB_TOOLS : []),
    ...(connected.github?.mode === "write" ? GITHUB_WRITE_TOOLS : []),
  ];
}

export const BROWSER_TOOLS: ToolDef[] = [
  fn("browser_list_tabs", "List the user's open browser tabs (id, title, url).", {}),
  fn("browser_read_tab", "Read a tab's visible text and its interactive elements (each has a numeric ref). The user must approve access to each site.", {
    tabId: { type: "integer" },
    maxChars: { type: "integer", description: "Optional text limit, 500-20000" },
  }, ["tabId"]),
  fn("browser_open_tab", "Open a URL in a new tab. The user must approve.", { url: { type: "string" } }, ["url"]),
  fn("browser_navigate", "Navigate an existing tab to a URL. The user must approve.", {
    tabId: { type: "integer" },
    url: { type: "string" },
  }, ["tabId", "url"]),
  fn("browser_click", "Click an element by its ref from the latest browser_read_tab. The user must approve.", {
    tabId: { type: "integer" },
    ref: { type: "integer" },
  }, ["tabId", "ref"]),
  fn("browser_type", "Type text into an input by its ref from the latest browser_read_tab. Never for passwords or card numbers. The user must approve.", {
    tabId: { type: "integer" },
    ref: { type: "integer" },
    text: { type: "string" },
    submit: { type: "boolean", description: "Press Enter after typing" },
  }, ["tabId", "ref", "text"]),
];

export const BROWSER_TOOL_NAMES = new Set(BROWSER_TOOLS.map((t) => t.function.name));
export const isBrowserTool = (name: string) => BROWSER_TOOL_NAMES.has(name);

const tabId = z.number().int().min(0).max(2_147_483_647);
const browserSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  browser_list_tabs: z.object({}).strict(),
  browser_read_tab: z.object({ tabId, maxChars: z.number().int().min(500).max(20000).optional() }).strict(),
  browser_open_tab: z.object({ url: z.string() }).strict(),
  browser_navigate: z.object({ tabId, url: z.string() }).strict(),
  browser_click: z.object({ tabId, ref: z.number().int().min(0).max(100000) }).strict(),
  browser_type: z
    .object({ tabId, ref: z.number().int().min(0).max(100000), text: z.string().max(2000), submit: z.boolean().optional() })
    .strict(),
};

export function validateBrowserCall(name: string, args: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const schema = browserSchemas[name];
  if (!schema) return { ok: false, error: `Unknown tool ${name}` };
  const parsed = schema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "Invalid arguments" };
  const out = parsed.data;
  if ("url" in out) {
    const v = validateBrowserUrl(out.url);
    if (!v.ok) return { ok: false, error: v.reason };
    out.url = v.url;
  }
  return { ok: true, args: out };
}
