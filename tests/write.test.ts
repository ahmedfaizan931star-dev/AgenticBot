import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ loadConnection: vi.fn() }));
vi.mock("@/lib/connectors/store", () => store);
vi.mock("@/lib/connectors/google", () => ({ accessToken: async () => "gtok" }));

import { driveWrite, githubWrite } from "@/lib/connectors/write";

const conn = (mode: "read" | "write") => ({ token: "tok", refresh: null, expiresAt: null, label: "me", mode });
const COMMIT = { repo: "o/r", path: "docs/a b.md", content: "héllo", message: "Add", branch: "agent/docs" };

type Call = { method: string; url: string; body?: Record<string, unknown> };
function mockGithub(handlers: Record<string, () => Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: url.replace("https://api.github.com", ""), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const key = `${method} ${url.replace("https://api.github.com", "").split("?")[0]}`;
      const h = handlers[key];
      if (!h) throw new Error(`unexpected request: ${key}`);
      return h();
    }),
  );
  return calls;
}

beforeEach(() => store.loadConnection.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("githubWrite", () => {
  it("refuses everything unless the connection is in write mode", async () => {
    store.loadConnection.mockResolvedValue(conn("read"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const t of ["github_create_issue", "github_comment", "github_commit_file", "github_open_pr"]) expect((await githubWrite("u", t, COMMIT)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("commits to a NEW agent branch created from the default branch, with the file base64-encoded", async () => {
    store.loadConnection.mockResolvedValue(conn("write"));
    const calls = mockGithub({
      "GET /repos/o/r": () => Response.json({ default_branch: "main" }),
      "GET /repos/o/r/git/ref/heads/agent/docs": () => new Response("{}", { status: 404 }),
      "GET /repos/o/r/git/ref/heads/main": () => Response.json({ object: { sha: "abc123" } }),
      "POST /repos/o/r/git/refs": () => Response.json({}, { status: 201 }),
      "GET /repos/o/r/contents/docs/a%20b.md": () => new Response("{}", { status: 404 }),
      "PUT /repos/o/r/contents/docs/a%20b.md": () => Response.json({ commit: { html_url: "https://github.com/o/r/commit/1" } }),
    });
    const out = await githubWrite("u", "github_commit_file", COMMIT);
    expect(out.ok).toBe(true);
    expect(out.text).toContain("agent/docs");
    const ref = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/refs"))!;
    expect(ref.body).toEqual({ ref: "refs/heads/agent/docs", sha: "abc123" });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({ branch: "agent/docs", message: "Add" });
    expect(Buffer.from(String(put.body!.content), "base64").toString("utf8")).toBe("héllo");
    expect(put.body!.sha).toBeUndefined();
    expect(calls.some((c) => c.method === "PUT" && c.body?.branch === "main")).toBe(false);
  });

  it("updates an existing file using its sha on the agent branch", async () => {
    store.loadConnection.mockResolvedValue(conn("write"));
    const calls = mockGithub({
      "GET /repos/o/r": () => Response.json({ default_branch: "main" }),
      "GET /repos/o/r/git/ref/heads/agent/docs": () => Response.json({ object: { sha: "x" } }),
      "GET /repos/o/r/contents/docs/a%20b.md": () => Response.json({ type: "file", sha: "oldsha" }),
      "PUT /repos/o/r/contents/docs/a%20b.md": () => Response.json({ commit: { html_url: "u" } }),
    });
    expect((await githubWrite("u", "github_commit_file", COMMIT)).ok).toBe(true);
    expect(calls.find((c) => c.method === "PUT")!.body!.sha).toBe("oldsha");
  });

  it("refuses to write when the branch equals the default branch", async () => {
    store.loadConnection.mockResolvedValue(conn("write"));
    mockGithub({ "GET /repos/o/r": () => Response.json({ default_branch: "agent/docs" }) });
    const out = await githubWrite("u", "github_commit_file", COMMIT);
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/default branch/);
  });

  it("opens a pull request against the default branch and explains a 422 plainly", async () => {
    store.loadConnection.mockResolvedValue(conn("write"));
    const calls = mockGithub({
      "GET /repos/o/r": () => Response.json({ default_branch: "main" }),
      "POST /repos/o/r/pulls": () => Response.json({ html_url: "https://github.com/o/r/pull/9" }, { status: 201 }),
    });
    const ok = await githubWrite("u", "github_open_pr", { repo: "o/r", title: "T", head: "agent/docs", body: "b" });
    expect(ok.text).toContain("pull/9");
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ base: "main", head: "agent/docs" });
    mockGithub({ "GET /repos/o/r": () => Response.json({ default_branch: "main" }), "POST /repos/o/r/pulls": () => new Response("{}", { status: 422 }) });
    expect((await githubWrite("u", "github_open_pr", { repo: "o/r", title: "T", head: "agent/docs" })).text).toMatch(/refused the pull request/);
  });

  it("creates issues and comments", async () => {
    store.loadConnection.mockResolvedValue(conn("write"));
    mockGithub({
      "POST /repos/o/r/issues": () => Response.json({ html_url: "https://github.com/o/r/issues/3", number: 3 }, { status: 201 }),
      "POST /repos/o/r/issues/3/comments": () => Response.json({ html_url: "https://github.com/o/r/issues/3#c" }, { status: 201 }),
    });
    expect((await githubWrite("u", "github_create_issue", { repo: "o/r", title: "Bug", body: "b" })).text).toContain("issues/3");
    expect((await githubWrite("u", "github_comment", { repo: "o/r", number: 3, body: "hi" })).ok).toBe(true);
  });

  it("has no merge or delete operations at all", async () => {
    store.loadConnection.mockResolvedValue(conn("write"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const t of ["github_merge_pr", "github_delete_file", "github_delete_branch"]) expect((await githubWrite("u", t, COMMIT)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("driveWrite", () => {
  it("creates a Google Doc from converted HTML and refuses without write mode", async () => {
    store.loadConnection.mockResolvedValue(conn("read"));
    expect((await driveWrite("u", "drive_create_doc", { title: "T", content: "x" })).ok).toBe(false);

    store.loadConnection.mockResolvedValue(conn("write"));
    const fetchMock = vi.fn(async () => Response.json({ name: "Plan", webViewLink: "https://docs.google.com/d/1" }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await driveWrite("u", "drive_create_doc", { title: "Plan", content: "# Heading\n\n<script>x</script>" });
    expect(out.ok).toBe(true);
    expect(out.text).toContain("docs.google.com");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("uploadType=multipart");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gtok");
    const body = String(init.body);
    expect(body).toContain('"mimeType":"application/vnd.google-apps.document"');
    expect(body).toContain("<h1>Heading</h1>");
    expect(body).not.toContain("<script>");
  });

  it("rejects other Drive operations", async () => {
    store.loadConnection.mockResolvedValue(conn("write"));
    expect((await driveWrite("u", "drive_delete_file", {})).ok).toBe(false);
  });
});
