# Agent Hub

Web app (Next.js on Vercel) + Chrome extension. The assistant researches the web with citations and, through the extension, can read and use your open tabs. You approve every browser action.

## Setup
1. **Supabase**: create a project, run `supabase/migrations/0001_init.sql` in the SQL editor. In Auth → Providers enable Email (and Google if wanted). Add `https://YOUR-APP.vercel.app/auth/callback` to Auth → URL Configuration → Redirect URLs.
2. **Vercel**: import the repo, copy the variables from `.env.example` (set `SUPABASE_SERVICE_ROLE_KEY` as a server-only secret).
3. **Extension**: set the GitHub repository variable `APP_ORIGIN=https://YOUR-APP.vercel.app`, run the CI workflow, download the `agent-hub-extension` artifact, unzip, then Chrome → `chrome://extensions` → Developer mode → Load unpacked. Click the extension icon: turn it on and tap *Grant tab access*.
   Desktop Chrome/Edge only (Android needs a browser that supports extensions, e.g. Kiwi).
4. Add credits manually: `select grant_credits('<user uuid>', 500, 'manual_grant', 'manual:' || gen_random_uuid()::text);`

Models: set `GEMINI_MODEL` / `OPENROUTER_MODEL` to model ids that exist on your accounts today. Search uses whichever of Brave / Tavily / Exa keys are set.

## Connectors, uploads, deep research (migration 0002)
Run `supabase/migrations/0002_connectors_files_research.sql` after 0001. Then:
- **Encryption key**: set `CONNECTOR_ENCRYPTION_KEY` (`openssl rand -base64 32`). Tokens are stored AES-256-GCM encrypted in a table clients cannot read.
- **Google Drive** (read-only, OAuth + PKCE): in Google Cloud enable the Drive API, create a Web OAuth client, add the redirect URI `https://YOUR-APP.vercel.app/api/connectors/google/callback`, set `GOOGLE_CLIENT_ID/SECRET`. While the consent screen is in *Testing* only listed test users can connect (fine for you and a few people). The `drive.readonly` scope is *restricted*: opening it to the public needs Google's verification review.
- **GitHub** (read-only): users paste a *fine-grained* token (Contents, Issues, Pull requests: read-only, chosen repos). Classic tokens with `repo` are accepted but the user is warned they can write.
- **File upload**: PDF, DOCX, TXT, MD, CSV, JSON and similar, up to 4 MB (Vercel's request-body limit). Text is extracted on the server and stored; scanned PDFs and images are not supported yet.
- **Deep research**: planned queries, parallel searches, page reading through Exa/Tavily (the server never fetches arbitrary URLs), then a cited report. Costs 10 credits, refunded if no sources are found. It runs in small steps driven by the open browser tab, so it works on Vercel Hobby and resumes if you reload; it pauses while the tab is closed (a cron worker would lift that).
- Connector lookups cost 1 credit each; reading an uploaded file is free.

## Round 2: write actions, Google search, more agent tools (migration 0003)
Run `supabase/migrations/0003_actions_audit.sql` after 0001 and 0002.
- **Write connectors, always with approval.** In *Connectors* choose read-only or read + write. A write tool call from the model only creates a *proposal*; you see the exact content and press Approve. The stored proposal (not the browser) is what runs, once, within 15 minutes, and it is re-validated at execution. Sending a new message expires anything still waiting.
  - GitHub: create issue, comment, write one file on a new `agent/<name>` branch, open a pull request. Never the default branch, never `.github/`, no merge, no delete.
  - Google Drive: create new Google Docs from Markdown (scope `drive.file`: only files this app creates). Existing files are never edited.
- **Activity log**: every connection and every proposed/approved/denied/failed action is recorded and shown on the Connectors page.
- **Google search (optional, off by default)**: Google's Custom Search API is closed to new customers, so this uses Gemini *Grounding with Google Search*. Set `GOOGLE_GROUNDING_ENABLED=true`. Google requires showing its search suggestions (the app shows them under the answer). Keep the key on the free tier (it cannot be billed) and check the current free allowance on Google's pricing page, because it differs by model. On the free tier Google may use submitted prompts to improve its products. App-level daily caps apply (`GOOGLE_GROUNDING_DAILY_CAP`, `GOOGLE_GROUNDING_USER_DAILY`). Costs 3 credits; failed calls are refunded.
- **New agent tools**: `read_webpage` (via Exa/Tavily, 1 credit), `update_plan` (visible checklist), parallel lookups, up to 8 steps per message (12 in Research mode) with a Continue button.

## Round 3: MCP apps (migration 0004)
Run `supabase/migrations/0004_mcp.sql`. On the Connectors page, *Apps (MCP)* lets a user connect any **remote** MCP server (Streamable HTTP, cloud-side). The agent can use several apps in the same step; calls run in parallel (max 6 at once), sharing one session per app per request.
- **Sign-in**: OAuth (PKCE; client ID metadata document at `/api/mcp/client-metadata`, dynamic registration as fallback; credentials bound to the authorization server's issuer), a pasted access token, or none. Credentials are AES-256-GCM encrypted in a table clients cannot read.
- **Both MCP eras**: the official SDK (v2) negotiates automatically, so servers on the 2026-07-28 spec and older 2025 servers both work.
- **Review before use**: after connecting, the user sees every tool and ticks the ones to allow. The tool list is fingerprinted; if the app later changes any tool (name, text, schema, hints) it is paused until the user reviews again. Descriptions are cleaned and truncated before the model sees them.
- **Approval**: policy per app. *Ask unless read-only* (default) runs tools the app marks read-only and turns everything else into an approval card; *Ask for every call* gates all. Approved calls run from the stored proposal, once, and are re-checked against the reviewed tool list.
- **Output is untrusted**: wrapped like web pages, size-capped, binary content never inlined.
- **SSRF**: https only; private, loopback, link-local, metadata and reserved addresses are blocked both in the URL and again at connect time (DNS rebinding); responses are size-limited. `MCP_ALLOW_PRIVATE=1` exists only for tests and must never be set in production.
- Not supported: local (stdio) servers, since a cloud app cannot reach a process on someone's computer. Each app call costs 1 credit (refunded on failure).
- Tool schemas sent to Gemini are stripped of keywords it may reject (`additionalProperties`, `$ref`, `default`, …).

## Credits
New accounts get 50. One model round costs 1, one web search costs 2. Spending is atomic in Postgres and idempotent per request; a failed model call is refunded. Clients cannot write balances (RLS + service-role-only functions).

## Security model
- Auth via Supabase; every API route verifies the user server-side; RLS on all tables; service key never reaches the browser.
- State-changing routes require a same-origin `Origin`; per-user rate limit (30 req/min) in Postgres.
- Chat history lives on the server; the browser can only send a new message or results for tool calls the server issued.
- Page text and search results are wrapped as untrusted data; the model is told never to follow instructions inside them.
- Extension: talks only to the configured app origin; off by default; tab access is an optional permission you grant; each site read needs approval (per browser session); every open/navigate/click/type needs approval in an extension-owned window; password/card/OTP fields are refused; only http(s) URLs.
- Security headers + CSP in `next.config.mjs`. The CSP still allows inline scripts (Next.js default); move to nonces for stricter.

## Not built yet
Generic MCP connectors, image/scanned-PDF upload, background (tab-closed) deep research, Telegram/WhatsApp, payments, sandbox code execution, write actions for connectors.

## Checks
`npm run typecheck && npm test && npm run build && npm run build:extension`
