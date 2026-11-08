import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb } from "./fakeDb";
import { startOauthServer } from "./oauthServer";

const h = vi.hoisted(() => ({ db: null as ReturnType<typeof import("./fakeDb").makeFakeDb> | null }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ratelimit", () => ({ allow: async () => true }));

import { McpPool } from "@/lib/mcp/client";
import { buildRegistry } from "@/lib/mcp/registry";
import { callResolved, discoverServer, finishOauth, openConnection, startOauth } from "@/lib/mcp/service";
import { createServer, getServer, loadOauthBlob, reviewServer } from "@/lib/mcp/store";

let as: Awaited<ReturnType<typeof startOauthServer>>;

beforeAll(async () => {
  vi.stubEnv("MCP_ALLOW_PRIVATE", "1");
  vi.stubEnv("CONNECTOR_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
  as = await startOauthServer();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await as.close();
});
beforeEach(() => {
  h.db = makeFakeDb();
});

async function newApp() {
  const made = await createServer("u1", { name: "Secure App", url: as.url, authType: "oauth" });
  if (!made.ok) throw new Error(made.error);
  return made.server;
}

/** Plays the part of the browser: follows the sign-in URL and returns the parameters of the redirect back to us. */
async function browserSignIn(redirectTo: string) {
  const res = await fetch(redirectTo, { redirect: "manual" });
  return new URL(res.headers.get("location")!).searchParams;
}

describe("OAuth sign-in to an MCP app (real client, real HTTP, PKCE)", () => {
  it("starts sign-in, completes it, stores tokens encrypted, and then works", async () => {
    const app = await newApp();
    const start = await startOauth("u1", app.id);
    expect(start.ok && start.redirectTo).toContain("/authorize");
    if (!start.ok || !start.redirectTo) throw new Error("no redirect");
    const u = new URL(start.redirectTo);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/mcp/oauth/callback");

    const params = await browserSignIn(start.redirectTo);
    const done = await finishOauth("u1", params);
    expect(done).toEqual({ ok: true });
    expect(as.log.tokenGrants).toContain("authorization_code");

    const after = (await getServer("u1", app.id))!;
    expect(after.status).toBe("needs_review");
    expect(after.tools.map((t) => t.name)).toEqual(["whoami"]);
    const row = h.db!.tables.mcp_servers![0]!;
    expect(String(row.oauth_enc)).toMatch(/^v1\./);
    expect(JSON.stringify(h.db!.tables)).not.toMatch(/at-\d|rt-1/);

    await reviewServer("u1", app.id, ["whoami"]);
    const active = (await getServer("u1", app.id))!;
    const pool = new McpPool(() => openConnection("u1", active));
    const out = await callResolved("u1", buildRegistry([active]).resolve.get("mcp_secure_app__whoami")!, {}, pool);
    await pool.closeAll();
    expect(out.ok).toBe(true);
    expect(out.text).toContain("signed-in-user");
  });

  it("refuses a sign-in callback with a wrong, missing or replayed state", async () => {
    const app = await newApp();
    const start = await startOauth("u1", app.id);
    if (!start.ok || !start.redirectTo) throw new Error("no redirect");
    const params = await browserSignIn(start.redirectTo);
    const grantsBefore = as.log.tokenGrants.length;

    const forged = new URLSearchParams(params);
    forged.set("state", "attacker-state");
    expect((await finishOauth("u1", forged)).ok).toBe(false);
    const stateless = new URLSearchParams(params);
    stateless.delete("state");
    expect((await finishOauth("u1", stateless)).ok).toBe(false);
    expect(as.log.tokenGrants.length).toBe(grantsBefore); // no token request was made for any bad callback

    expect((await finishOauth("u1", params)).ok).toBe(true);
    expect((await finishOauth("u1", params)).ok).toBe(false); // the state is single-use
  });

  it("one user's sign-in link cannot complete for another user", async () => {
    const app = await newApp();
    const start = await startOauth("u1", app.id);
    if (!start.ok || !start.redirectTo) throw new Error("no redirect");
    const params = await browserSignIn(start.redirectTo);
    expect((await finishOauth("u2", params)).ok).toBe(false);
    expect((await getServer("u1", app.id))!.status).toBe("needs_auth");
  });

  it("refreshes an expired access token by itself", async () => {
    const app = await newApp();
    const start = await startOauth("u1", app.id);
    if (!start.ok || !start.redirectTo) throw new Error("no redirect");
    await finishOauth("u1", await browserSignIn(start.redirectTo));
    await reviewServer("u1", app.id, ["whoami"]);
    as.revokeAccessToken();
    const before = as.log.tokenGrants.filter((g) => g === "refresh_token").length;
    const d = await discoverServer("u1", app.id);
    expect(d.ok).toBe(true);
    expect(as.log.tokenGrants.filter((g) => g === "refresh_token").length).toBe(before + 1);
    expect((await loadOauthBlob("u1", app.id)).lastTokens?.access_token).toMatch(/^at-/);
  });

  it("signals that sign-in is needed when no token exists", async () => {
    const app = await newApp();
    const d = await discoverServer("u1", app.id);
    expect(d).toMatchObject({ ok: false, needsAuth: true });
  });
});
