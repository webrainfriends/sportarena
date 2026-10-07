# Contributing

`main` is the release branch. **Nothing is committed to `main` directly — every change goes through a pull request.**

## Flow
1. Branch from the latest `main`: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`, `docs/<topic>`.
2. Make small, focused commits using [Conventional Commits](https://www.conventionalcommits.org/):
   `feat(events): auto-schedule knockout brackets` · `fix(bookings): reject zero-length slots` · `docs: …`
3. Push the branch and open a PR into `main` (the PR template guides the description).
4. CI (`.github/workflows/ci.yml`) runs API tests against Postgres and builds the web app.
5. A maintainer reviews and merges manually. Builds can also be triggered from **Actions → CI → Run workflow**.

## Local checks before pushing
```bash
npm test                                   # API suites against local Postgres
cd apps/app && npx expo export --platform web   # app bundles
```
