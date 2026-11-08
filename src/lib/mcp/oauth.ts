import "server-only";
import { randomBytes } from "node:crypto";
import type { OAuthClientInformationContext, OAuthClientProvider, OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client";

/** Everything OAuth needs to remember about one server, stored encrypted as a single JSON value. */
export type OAuthBlob = {
  clients?: Record<string, StoredOAuthClientInformation>;
  tokens?: Record<string, StoredOAuthTokens>;
  lastTokens?: StoredOAuthTokens;
  pending?: { state: string; verifier?: string; at: number; discovery?: OAuthDiscoveryState };
};

const KEY = "_";
export const PENDING_MAX_AGE_MS = 10 * 60_000;

export const oauthRedirectUrl = () => `${(process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "")}/api/mcp/oauth/callback`;
const metadataUrl = () => {
  const u = `${(process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "")}/api/mcp/client-metadata`;
  return u.startsWith("https://") ? u : undefined; // Client ID Metadata Documents must be served over https
};

/**
 * Database-backed OAuth state for one MCP server. Client credentials are keyed by the authorization server's issuer
 * (as the 2026-07-28 spec requires) and are never reused with another issuer.
 */
export class DbOAuthProvider implements OAuthClientProvider {
  authorizationUrl: string | null = null;
  constructor(
    private blob: OAuthBlob,
    private persist: (b: OAuthBlob) => Promise<void>,
    private redirect: string = oauthRedirectUrl(),
  ) {}

  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadataUrl() {
    return metadataUrl();
  }
  get clientMetadata() {
    return {
      client_name: "Agent Hub",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
    } as never;
  }

  async state() {
    const state = randomBytes(24).toString("base64url");
    this.blob.pending = { ...this.blob.pending, state, at: Date.now() };
    await this.persist(this.blob);
    return state;
  }
  clientInformation(ctx?: OAuthClientInformationContext) {
    return this.blob.clients?.[ctx?.issuer ?? KEY];
  }
  async saveClientInformation(info: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext) {
    this.blob.clients = { ...this.blob.clients, [ctx?.issuer ?? KEY]: info };
    await this.persist(this.blob);
  }
  tokens(ctx?: OAuthClientInformationContext) {
    return ctx ? this.blob.tokens?.[ctx.issuer] : (this.blob.lastTokens ?? this.blob.tokens?.[KEY]);
  }
  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext) {
    this.blob.tokens = { ...this.blob.tokens, [ctx?.issuer ?? KEY]: tokens };
    this.blob.lastTokens = tokens;
    await this.persist(this.blob);
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url.toString();
  }
  async saveCodeVerifier(verifier: string) {
    this.blob.pending = { ...this.blob.pending, state: this.blob.pending?.state ?? "", verifier, at: this.blob.pending?.at ?? Date.now() };
    await this.persist(this.blob);
  }
  /** Remembers which authorization server we discovered, so the callback can check the code came from that same server. */
  async saveDiscoveryState(discovery: OAuthDiscoveryState) {
    this.blob.pending = { state: this.blob.pending?.state ?? "", at: this.blob.pending?.at ?? Date.now(), ...this.blob.pending, discovery };
    await this.persist(this.blob);
  }
  discoveryState() {
    return this.blob.pending?.discovery;
  }
  codeVerifier() {
    if (!this.blob.pending?.verifier) throw new Error("No sign-in in progress");
    return this.blob.pending.verifier;
  }

  /** True only for the exact state we issued, recently, and exactly once. */
  consumeState(returned: string | null): boolean {
    const p = this.blob.pending;
    if (!p || !returned || p.state.length === 0 || p.state !== returned || Date.now() - p.at > PENDING_MAX_AGE_MS) return false;
    return true;
  }
  async clearPending() {
    delete this.blob.pending;
    await this.persist(this.blob);
  }
}
