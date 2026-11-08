import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod4";

/** A tiny OAuth 2.1 authorization server + protected MCP server, just enough to exercise the real client flow. */
export async function startOauthServer() {
  let n = 0;
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const log = { registered: 0, authorized: 0, tokenGrants: [] as string[], mcpAuth: [] as string[] };
  let validToken = "";
  let base = "";
  const read = (req: IncomingMessage) => new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
  const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base || "http://127.0.0.1");
    const p = url.pathname;
    if (p.startsWith("/.well-known/oauth-protected-resource")) return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"] });
    if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration") {
      return json(res, 200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (p === "/register" && req.method === "POST") {
      log.registered++;
      const meta = JSON.parse(await read(req)) as Record<string, unknown>;
      return json(res, 201, { ...meta, client_id: "cid-1" });
    }
    if (p === "/authorize") {
      log.authorized++;
      const code = `code-${++n}`;
      const redirect = url.searchParams.get("redirect_uri")!;
      codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return void res.writeHead(302, { Location: back.toString() }).end();
    }
    if (p === "/token" && req.method === "POST") {
      const f = new URLSearchParams(await read(req));
      const grant = f.get("grant_type") ?? "";
      log.tokenGrants.push(grant);
      if (grant === "authorization_code") {
        const c = codes.get(f.get("code") ?? "");
        const verifier = f.get("code_verifier") ?? "";
        if (!c || c.redirect !== f.get("redirect_uri") || createHash("sha256").update(verifier).digest("base64url") !== c.challenge) return json(res, 400, { error: "invalid_grant" });
        codes.delete(f.get("code")!);
      } else if (grant !== "refresh_token" || f.get("refresh_token") !== "rt-1") return json(res, 400, { error: "invalid_grant" });
      validToken = `at-${++n}`;
      return json(res, 200, { access_token: validToken, token_type: "Bearer", expires_in: 3600, refresh_token: "rt-1" });
    }
    if (p === "/mcp") {
      log.mcpAuth.push(String(req.headers.authorization ?? ""));
      if (!validToken || req.headers.authorization !== `Bearer ${validToken}`) {
        res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`, "Content-Type": "application/json" }).end("{}");
        return;
      }
      const server = new McpServer({ name: "oauth-test", version: "1.0.0" });
      server.registerTool("whoami", { description: "Returns a fixed identity", inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "signed-in-user" }] }));
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      return void (await transport.handleRequest(req, res));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    url: `${base}/mcp`,
    log,
    revokeAccessToken: () => { validToken = "revoked"; },
    close: () => new Promise<void>((r) => { http.closeAllConnections?.(); http.close(() => r()); }),
  };
}
