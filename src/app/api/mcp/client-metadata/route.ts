import { oauthRedirectUrl } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

/** Public OAuth "client ID metadata document": apps that support it learn who we are from this URL, with no registration step. */
export function GET() {
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
  return Response.json(
    {
      client_id: `${site}/api/mcp/client-metadata`,
      client_name: "Agent Hub",
      client_uri: site,
      redirect_uris: [oauthRedirectUrl()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
    },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
