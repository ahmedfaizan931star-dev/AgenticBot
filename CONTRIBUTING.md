# Contributing to AgenticBot

Thanks for helping. Small, focused pull requests are easiest to review.

## Setup

```bash
git clone https://github.com/ahmedfaizan931star-dev/AgenticBot
cd AgenticBot
npm ci
cp .env.example .env.local   # fill in what you need
```

Most of the test suite needs no secrets: Postgres and the model provider are faked in `tests/`.

## Before you open a PR

```bash
npm run typecheck
npm test
npm run build
npm run build:extension
```

All four must pass; CI runs the same commands.

## Pull request rules

- One change per PR, with a short description of *why*.
- Add or update a test for behavior changes.
- Do not commit secrets, `.env` files or real tokens.
- Do not weaken a security rule (approvals, SSRF guard, encryption, RLS) to make a feature easier. If you think a rule is wrong, open an issue and explain.

## Security-sensitive areas

Changes here get extra review and need tests:

- `src/lib/actions/`: the proposal and approval flow
- `src/lib/mcp/`: OAuth, SSRF guard, tool review
- `src/lib/crypto.ts` and `src/lib/connectors/`: credential storage
- `supabase/migrations/`: RLS policies and credit functions
- `extension/src/`: what the extension may read or do

## Good first contributions

- Docs and setup-guide improvements
- More tests for edge cases in `src/lib/files/` and `src/lib/research/`
- Error messages and empty states in the UI
- Anything on the roadmap in the README (open an issue first)

## Reporting bugs and vulnerabilities

Bugs: open an issue with steps to reproduce. Vulnerabilities: do not open a public issue, see [SECURITY.md](SECURITY.md).
