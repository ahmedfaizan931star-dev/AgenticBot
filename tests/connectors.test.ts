import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ loadConnection: vi.fn(), saveConnection: vi.fn(), deleteConnection: vi.fn() }));
vi.mock("@/lib/connectors/store", () => store);

import { connectGithub, githubListIssues, githubReadFile, githubSearchCode, safePath, REPO_RE } from "@/lib/connectors/github";
import { driveRead, driveSearch, escapeDriveQuery, authUrl, newPkce } from "@/lib/connectors/google";

const future = () => new Date(Date.now() + 3600_000);
const conn = (over = {}) => ({ token: "tok", refresh: "ref", expiresAt: future(), label: "me", ...over });

beforeEach(() => {
  store.loadConnection.mockReset();
  store.saveConnection.mockReset();
  vi.stubEnv("GOOGLE_CLIENT_ID", "cid");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "sec");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Google Drive", () => {
  it("escapes quotes and backslashes so a query cannot break out of the Drive filter", () => {
    expect(escapeDriveQuery("it's")).toBe("it\\'s");
    expect(escapeDriveQuery("a\\' or name contains '")).toBe("a\\\\\\' or name contains \\'");
    expect(escapeDriveQuery("line\nbreak")).toBe("line break");
  });

  it("sends the escaped query to Drive and wraps results as untrusted", async () => {
    store.loadConnection.mockResolvedValue(conn());
    const fetchMock = vi.fn(async () => Response.json({ files: [{ id: "abc1234567", name: "Plan", mimeType: "application/pdf", modifiedTime: "2026-01-01", webViewLink: "https://drive.google.com/x" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await driveSearch("u", "x' or trashed = true or name contains '");
    const url = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url.searchParams.get("q")).toBe("fullText contains 'x\\' or trashed = true or name contains \\'' and trashed = false");
    expect(out.ok && out.text.startsWith("<untrusted_connector_data>")).toBe(true);
    expect(out.text).toContain("id: abc1234567");
  });

  it("asks to reconnect when there is no connection, without calling Google", async () => {
    store.loadConnection.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await driveSearch("u", "x");
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/reconnect/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and stores the new one", async () => {
    store.loadConnection.mockResolvedValue(conn({ expiresAt: new Date(Date.now() - 1000) }));
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("oauth2.googleapis.com/token") ? Response.json({ access_token: "newtok", expires_in: 3600 }) : Response.json({ files: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await driveSearch("u", "x");
    expect(store.saveConnection).toHaveBeenCalledWith("u", "google", expect.objectContaining({ token: "newtok", refresh: "ref" }));
    const call = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect((call[1].headers as Record<string, string>).Authorization).toBe("Bearer newtok");
  });

  it("rejects malformed file ids before any request", async () => {
    store.loadConnection.mockResolvedValue(conn());
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bad of ["../etc", "a b", "x", 5, undefined, "a".repeat(200)]) expect((await driveRead("u", bad, 0)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a Google Doc through the text export endpoint", async () => {
    store.loadConnection.mockResolvedValue(conn());
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/export") ? new Response("Meeting notes body") : Response.json({ id: "abc1234567", name: "Notes", mimeType: "application/vnd.google-apps.document" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await driveRead("u", "abc1234567", 0);
    expect(out.ok).toBe(true);
    expect(out.text).toContain("Meeting notes body");
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toContain("mimeType=text%2Fplain");
  });

  it("refuses Google file types that have no text form", async () => {
    store.loadConnection.mockResolvedValue(conn());
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "abc1234567", name: "Map", mimeType: "application/vnd.google-apps.map" })));
    expect((await driveRead("u", "abc1234567", 0)).ok).toBe(false);
  });

  it("builds an OAuth URL that asks only for read-only Drive access with PKCE", () => {
    const { challenge, state } = newPkce();
    const u = new URL(authUrl(state, challenge));
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.readonly");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.test/api/connectors/google/callback");
    expect(u.searchParams.get("state")).toBe(state);
  });
});

describe("GitHub", () => {
  it("validates repo names and paths", () => {
    expect(REPO_RE.test("octo/hello-world")).toBe(true);
    for (const bad of ["octo", "a/b/c", "a/b; rm", "../x", "a/..", "a/.", "a/b?x=1", " a/b", "-a/b", "a_b/c"]) expect(REPO_RE.test(bad)).toBe(false);
    expect(safePath("src/lib/a b.ts")).toBe("src/lib/a%20b.ts");
    expect(safePath("")).toBe("");
    for (const bad of ["../secret", "a/../../b", "a\\b", "x\u0000y", "a".repeat(400), 5]) expect(safePath(bad)).toBeNull();
  });

  it("does not call GitHub for invalid input", async () => {
    store.loadConnection.mockResolvedValue(conn());
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await githubReadFile("u", "bad repo", "a", undefined, 0)).ok).toBe(false);
    expect((await githubReadFile("u", "o/r", "../x", undefined, 0)).ok).toBe(false);
    expect((await githubReadFile("u", "o/r", "a", "main; x", 0)).ok).toBe(false);
    expect((await githubSearchCode("u", "q", "nope")).ok).toBe(false);
    expect((await githubListIssues("u", "../x", "open")).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("decodes a file and wraps it as untrusted data", async () => {
    store.loadConnection.mockResolvedValue(conn());
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ type: "file", encoding: "base64", content: Buffer.from("console.log(1)").toString("base64"), name: "a.js" })));
    const out = await githubReadFile("u", "o/r", "a.js", undefined, 0);
    expect(out.ok).toBe(true);
    expect(out.text).toContain("console.log(1)");
    expect(out.text.startsWith("<untrusted_connector_data>")).toBe(true);
  });

  it("lists a directory and refuses binary files", async () => {
    store.loadConnection.mockResolvedValue(conn());
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([{ name: "src", type: "dir", size: 0 }, { name: "a.ts", type: "file", size: 10 }])));
    expect((await githubReadFile("u", "o/r", "", undefined, 0)).text).toContain("[dir] src");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ type: "file", encoding: "base64", content: Buffer.from([1, 0, 2]).toString("base64") })));
    expect((await githubReadFile("u", "o/r", "x.bin", undefined, 0)).ok).toBe(false);
  });

  it("explains a 404 as not found or no access", async () => {
    store.loadConnection.mockResolvedValue(conn());
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    expect((await githubReadFile("u", "o/r", "x", undefined, 0)).text).toMatch(/Not found/);
  });

  it("warns when a pasted classic token can write to repositories", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ login: "octo" }), { headers: { "x-oauth-scopes": "repo, read:user" } })));
    const r = await connectGithub("u", "ghp_" + "a".repeat(36));
    expect(r.ok && r.warning).toMatch(/change your repositories/);
    expect(store.saveConnection).toHaveBeenCalledTimes(1);
  });

  it("accepts a fine-grained token without a warning and rejects junk or bad tokens", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ login: "octo" })));
    const ok = await connectGithub("u", "github_pat_" + "a".repeat(40));
    expect(ok.ok && ok.warning).toBeUndefined();
    store.saveConnection.mockClear();
    expect((await connectGithub("u", "not a token!")).ok).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    expect((await connectGithub("u", "ghp_" + "b".repeat(36))).ok).toBe(false);
    expect(store.saveConnection).not.toHaveBeenCalled();
  });
});
