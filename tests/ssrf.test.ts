import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicUrl, isBlockedIp, limitResponse } from "@/lib/mcp/ssrf";

afterEach(() => vi.unstubAllEnvs());

describe("isBlockedIp", () => {
  it("blocks private, loopback, link-local, metadata and reserved IPv4", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.5"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });
  it("allows ordinary public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "93.184.216.34", "100.63.0.1"]) expect(isBlockedIp(ip), ip).toBe(false);
  });
  it("blocks private IPv6, including IPv4 hidden inside IPv6", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::a00:1", "2002:7f00:1::", "2001:db8::1", "fec0::1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });
  it("allows public IPv6 and rejects things that are not IPs", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  it("accepts public https servers", () => {
    expect(assertPublicUrl("https://mcp.example.com/mcp").ok).toBe(true);
    expect(assertPublicUrl(" https://mcp.example.com/mcp#frag ").ok).toBe(true);
  });
  it("rejects http, credentials, private literals and internal names", () => {
    for (const bad of ["http://mcp.example.com", "https://user:pw@mcp.example.com", "https://127.0.0.1/mcp", "https://[::1]/mcp", "https://169.254.169.254/latest", "https://localhost/mcp", "https://db.internal/mcp", "https://printer.local/mcp", "https://intranet/mcp", "ftp://x.com", "", 5, "nope"]) {
      expect(assertPublicUrl(bad).ok, String(bad)).toBe(false);
    }
  });
  it("only tests may allow private networks", () => {
    expect(assertPublicUrl("http://127.0.0.1:3000/mcp").ok).toBe(false);
    vi.stubEnv("MCP_ALLOW_PRIVATE", "1");
    expect(assertPublicUrl("http://127.0.0.1:3000/mcp").ok).toBe(true);
  });
});

describe("limitResponse", () => {
  it("errors the stream once the byte limit is exceeded", async () => {
    const big = new Response(new Uint8Array(2000));
    await expect(limitResponse(big, 1000).arrayBuffer()).rejects.toThrow(/too large/);
  });
  it("passes small responses through", async () => {
    expect(await limitResponse(new Response("hello"), 1000).text()).toBe("hello");
  });
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { guardedFetch, guardedLookup } from "@/lib/mcp/ssrf";

describe("connect-time guard (stops DNS rebinding: a public-looking name that resolves to a private address)", () => {
  it("refuses to connect to a name that resolves to loopback, even though the URL looked harmless", async () => {
    const srv = createServer((_req, res) => res.end("secret internal data"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    try {
      await expect(guardedFetch(`http://localhost:${port}/`)).rejects.toThrow();
      vi.stubEnv("MCP_ALLOW_PRIVATE", "1");
      const res = await guardedFetch(`http://localhost:${port}/`);
      expect(await res.text()).toBe("secret internal data");
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("the lookup itself reports a block for private answers", async () => {
    const result = await new Promise<{ err: Error | null }>((resolve) => guardedLookup("localhost", { all: true }, (err) => resolve({ err })));
    expect(result.err?.message).toMatch(/Blocked/);
  });
});
