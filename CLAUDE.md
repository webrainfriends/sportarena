# Working agreements for AI assistants

- **Never commit or push to `main`.** Every change goes on a new branch (`feat/…`, `fix/…`, `chore/…`, `docs/…`) cut from the latest `origin/main`, and is delivered as a pull request into `main`.
- Open the PR automatically when the work is done, using `.github/pull_request_template.md`. Do **not** merge it — the maintainer merges manually and triggers builds.
- One concern per PR. Conventional Commit messages (`feat(scope): …`), clear body explaining the why.
- Run `npm test` (needs Postgres; see README) before pushing. Never commit `.env` or secrets.
- Features are added as capabilities in `apps/api/src/capabilities/*` (one definition → REST + OpenAPI + MCP). Personal identification data must use field-level encryption (`src/crypto.js`) and be audit-logged when decrypted.
- **Never ask the maintainer to log in to EC2 or run commands on a server.** Do server work through GitHub Actions (the runner SSHes in with the repo secrets) and read the results yourself via the GitHub API (list runs, get job logs; start a run with a workflow dispatch). If a workflow doesn't give enough visibility, add diagnostics to it in a PR instead of asking for manual steps. Only ask the maintainer for what only they can do: secrets, IAM/KMS permissions, security-group rules, and merging.
- **No dummy or hard-coded demo data.** Build real, usable modules: don't add seed rows, sample records or fake fixtures for new features, and don't hard-code example values into the UI. Tests create their own data; empty states and real forms are the default experience.
