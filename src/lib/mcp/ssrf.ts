import "server-only";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/** Only tests may set this: it lets the client talk to http://127.0.0.1 test servers. Never set it in production. */
export const allowPrivateNetworks = () => process.env.MCP_ALLOW_PRIVATE === "1";

const v4 = (ip: string): number[] | null => {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
};

function blockedV4(n: number[]): boolean {
  const [a, b, c] = n as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands an IPv6 address into eight 16-bit groups, or null if it is not valid. */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0]!;
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const q = v4(dotted[1]!);
    if (!q) return null;
    s = s.slice(0, -dotted[1]!.length) + ((q[0]! << 8) | q[1]!).toString(16) + ":" + ((q[2]! << 8) | q[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

/** True for any address that must never be reached from the server: private, loopback, link-local, metadata, reserved. */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = v4(ip);
    return !n || blockedV4(n);
  }
  if (kind === 6) {
    const g = expandV6(ip);
    if (!g) return true;
    const first = g[0]!;
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible and NAT64 (64:ff9b::/96) carry an IPv4 address in the last 32 bits.
    const embedded = [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return blockedV4(embedded);
    if (first === 0x64 && g[1] === 0xff9b) return blockedV4(embedded);
    return (
      (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
      (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
      (first & 0xffc0) === 0xfec0 || // site-local
      (first & 0xff00) === 0xff00 || // multicast
      first === 0x2002 || // 6to4
      (first === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) || // Teredo, documentation
      first === 0x100 // discard-only
    );
  }
  return true; // not an IP at all
}

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|localdomain|lan|home|corp|intranet)$/i;

/** Validates a user-supplied MCP server URL before anything connects to it. */
export function assertPublicUrl(raw: unknown): { ok: true; url: URL } | { ok: false; reason: string } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return { ok: false, reason: "Enter the server URL." };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "That is not a valid URL." };
  }
  const priv = allowPrivateNetworks();
  if (u.protocol !== "https:" && !(priv && u.protocol === "http:")) return { ok: false, reason: "Only https:// servers are allowed." };
  if (u.username || u.password) return { ok: false, reason: "Put credentials in the token field, not in the URL." };
  u.hash = "";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!priv) {
    if (isIP(host) && isBlockedIp(host)) return { ok: false, reason: "That address is private and cannot be used." };
    if (BLOCKED_NAMES.test(host) || !host.includes(".") && !isIP(host)) return { ok: false, reason: "Use a public server address." };
  }
  return { ok: true, url: u };
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Stops a hostile server from streaming an unbounded response into memory. */
export function limitResponse(res: Response, max = MAX_RESPONSE_BYTES): Response {
  if (!res.body) return res;
  let seen = 0;
  const limited = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        seen += chunk.byteLength;
        if (seen > max) ctrl.error(new Error("MCP response too large"));
        else ctrl.enqueue(chunk);
      },
    }),
  );
  return new Response(limited, { status: res.status, statusText: res.statusText, headers: res.headers });
}

type LookupCb = (err: Error | null, address?: string | { address: string; family: number }[], family?: number) => void;

/** Resolves a name and refuses to connect if ANY answer is a private address (this also stops DNS rebinding). */
export function guardedLookup(hostname: string, options: { all?: boolean }, cb: LookupCb) {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err);
    if (!allowPrivateNetworks() && addresses.some((a) => isBlockedIp(a.address))) return cb(new Error("Blocked: the address is private"));
    if (options?.all) return cb(null, addresses);
    const first = addresses[0];
    return first ? cb(null, first.address, first.family) : cb(new Error("No address found"));
  });
}

let agent: Agent | null = null;

/** fetch for the MCP client: every connection is IP-checked at connect time, redirects stay inside the guard, bodies are size-limited. */
export const guardedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  agent ??= new Agent({ connect: { lookup: guardedLookup as never }, headersTimeout: 30_000, bodyTimeout: 60_000 });
  const url = typeof input === "string" || input instanceof URL ? input : input.url;
  const res = await undiciFetch(url as string, { ...(init as object), dispatcher: agent } as never);
  return limitResponse(res as unknown as Response);
};
