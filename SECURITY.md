# Security Policy

AgenticBot can read web pages, connect to third-party apps and act in a browser, so security reports are taken seriously.

## Reporting a vulnerability

Please do **not** open a public issue.

Use GitHub's private reporting: **Security tab → Report a vulnerability** on this repository. Include what you found, steps to reproduce, and the impact you expect.

You can expect an acknowledgement within a few days. This is a small project with one maintainer, so fixes are best-effort, but confirmed issues are prioritised over features and credited in the release notes if you wish.

## In scope

- Bypassing the approval flow (a write or browser action running without approval)
- SSRF or access to private network addresses through the MCP client
- Credential leakage (stored connector or MCP tokens, service key exposure)
- Prompt-injection paths that make the agent act without user approval
- Broken access control or RLS gaps in `supabase/migrations/`
- Extension behavior that exceeds its documented permissions

## Out of scope

- Findings that need a malicious or already-compromised user account
- Missing rate limits on your own self-hosted deployment settings
- Issues in third-party services (Supabase, Vercel, Google, MCP servers you connect)

## Supported versions

Only the latest commit on `main` is supported.
