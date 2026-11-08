# AgenticBot

**An open-source AI browsing assistant where you approve every action.**

AgenticBot is a Next.js web app plus a Chrome extension. The assistant researches the web with citations, reads your connected apps, and, through the extension, can read and act on your open tabs. Nothing that changes something happens without your explicit approval.

[![CI](https://github.com/ahmedfaizan931star-dev/AgenticBot/actions/workflows/ci.yml/badge.svg)](https://github.com/ahmedfaizan931star-dev/AgenticBot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why this exists

Most agent products ask you to trust them with broad access. AgenticBot is built the other way round: read-only by default, every write or browser action is a visible proposal, and the code that enforces this is small, tested and open for review.

## Features

- **Cited web research**: planned queries, parallel searches (Brave, Tavily or Exa), a cited report. Deep research resumes if you reload the page.
- **Browser control through an extension**: list tabs, read page text and interactive elements, open, navigate, click and type. Each site read and each action needs your approval.
- **Connectors**: Google Drive (read-only OAuth + PKCE, or create new Docs) and GitHub (fine-grained token; issues, comments, and pull requests on new `agent/<name>` branches only).
- **MCP apps**: connect any remote MCP server (Streamable HTTP). You review and tick each tool before the agent can use it, and tool changes pause the app until you review again.
- **File upload**: PDF, DOCX, TXT, MD, CSV, JSON (up to 4 MB), text extracted server-side.
- **Credits and rate limits**: atomic, idempotent spending in Postgres; failed model calls are refunded.
- **Activity log**: every connection and every proposed, approved, denied or failed action is recorded.

## Security model

| Area | What it does |
| --- | --- |
| Approvals | Write tools only create a *proposal*. The stored proposal, not the browser, is what runs: once, within 15 minutes, re-validated at execution. |
| Untrusted content | Web pages, search results and MCP output are wrapped as data; the model is told never to follow instructions inside them. |
| Secrets | Connector and MCP credentials are AES-256-GCM encrypted in tables clients cannot read. The service key never reaches the browser. |
| SSRF | MCP URLs must be https; private, loopback, link-local and metadata addresses are blocked at input and again at connect time (DNS rebinding). |
| Database | Row Level Security on all tables; only service-role functions can change balances. |
| Requests | Server-side auth on every API route, same-origin check on state-changing routes, per-user rate limit. |
| Extension | Off by default, talks only to your app origin, tab access is an optional permission, password/card/OTP fields are refused, http(s) only. |

Found a problem? See [SECURITY.md](SECURITY.md).

## Architecture

```
extension/        Chrome extension (background, content script, approval window)
src/app/          Next.js routes and API endpoints
src/lib/agent/    Agent loop, tools, system prompt, history
src/lib/mcp/      MCP client, OAuth, SSRF guard, tool review
src/lib/connectors/  Google Drive and GitHub connectors, write proposals
src/lib/research/ Deep research planner and page reader
supabase/migrations/  Schema, RLS, credit and audit functions
tests/            Vitest unit and integration tests
```

Stack: Next.js 15, React 19, TypeScript, Supabase (Auth + Postgres), Vercel, the official MCP TypeScript SDK, Gemini (OpenRouter fallback) through OpenAI-compatible endpoints.

## Quick start

1. **Supabase**: create a project and run the files in `supabase/migrations/` in order (`0001` to `0004`). In Auth → Providers enable Email. Add `https://YOUR-APP.vercel.app/auth/callback` to Redirect URLs.
2. **Environment**: copy `.env.example` to `.env.local` and fill it in. Set `CONNECTOR_ENCRYPTION_KEY` with `openssl rand -base64 32`. Keep `SUPABASE_SERVICE_ROLE_KEY` server-only.
3. **Run locally**:
   ```bash
   npm ci
   npm run dev
   ```
4. **Deploy**: import the repo on Vercel and copy the same variables.
5. **Extension**: set the repository variable `APP_ORIGIN=https://YOUR-APP.vercel.app`, run the CI workflow, download the `agent-hub-extension` artifact, unzip it, then in Chrome open `chrome://extensions` → Developer mode → Load unpacked. Click the icon, turn it on, and press *Grant tab access*. Desktop Chrome or Edge only.
6. **Credits**: new accounts get 50. Add more with `select grant_credits('<user uuid>', 500, 'manual_grant', 'manual:' || gen_random_uuid()::text);`

Set `GEMINI_MODEL` / `OPENROUTER_MODEL` to model ids that exist on your accounts.

### Google Drive note

The `drive.readonly` scope is *restricted* by Google. While your OAuth consent screen is in Testing, only listed test users can connect. Public use needs Google's verification review.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run build:extension
```

CI runs all four on every push and pull request. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

- [ ] Image and scanned-PDF upload (OCR)
- [ ] Background deep research that continues with the tab closed
- [ ] Nonce-based CSP (the current CSP allows inline scripts, a Next.js default)
- [ ] Local (stdio) MCP servers through a companion app
- [ ] Telegram / WhatsApp front-ends
- [ ] Sandboxed code execution

Pick anything from this list and open an issue first so we can agree on the approach.

## License

[MIT](LICENSE)
