# Working agreements for AI assistants

- **Never commit or push to `main`.** Every change goes on a new branch (`feat/…`, `fix/…`, `chore/…`, `docs/…`) cut from the latest `origin/main`, and is delivered as a pull request into `main`.
- Open the PR automatically when the work is done, using `.github/pull_request_template.md`. Do **not** merge it — the maintainer merges manually and triggers builds.
- One concern per PR. Conventional Commit messages (`feat(scope): …`), clear body explaining the why.
- Run `npm test` (needs Postgres; see README) before pushing. Never commit `.env` or secrets.
- Features are added as capabilities in `apps/api/src/capabilities/*` (one definition → REST + OpenAPI + MCP). Personal identification data must use field-level encryption (`src/crypto.js`) and be audit-logged when decrypted.
