# Deploying to EC2 (side by side with myhealthpal)

SportArena deploys to the **same EC2 host** as myhealthpal using the same mechanism (GitHub Actions → SSH → pm2 +
Docker Postgres + nginx) and the same credentials. Everything it creates is namespaced, so existing apps are untouched.

| Thing | SportArena | Notes |
|---|---|---|
| Public site (nginx, TLS) | **9255** | own file `/etc/nginx/sites-available/sportarena`; other sites are never edited |
| Postgres (Docker, 127.0.0.1 only) | **7255** | container `sportarena-postgres`, volume `sportarena_pgdata`, db/user `sportarena` |
| API (pm2, localhost via nginx) | 4255 | process `sportarena-api`; not exposed |
| Web build | `/var/www/sportarena-web` | Expo web export, same origin as the API |
| App dir / env | `~/sportarena`, `~/sportarena/.env` (mode 600) | created on first deploy |
| Master key | `/var/lib/sportarena/master.key.enc` | **wrapped by AWS KMS**; plaintext never on disk |

## One-time setup
1. **Repository secrets** (Settings → Secrets and variables → Actions) — same values as myhealthpal:
   - `EC2_SSH_KEY` — private key (PEM) of the instance's key pair
   - `KMS_KEY_ID` — the KMS key (ARN / id / alias) the instance role can use

   GitHub secrets are per repository, so copy them in (or define them once as *organization* secrets shared with
   this repo). The workflow runs in the `production` environment: if you keep these as *environment* secrets, add them
   to this repo's `production` environment.
2. **Security group:** allow inbound **TCP 9255**. Do **not** open 7255 or 4255.
3. **KMS:** nothing new if the instance role already has `kms:GenerateDataKey` + `kms:Decrypt` on that key (it does
   for myhealthpal). The first deploy creates the wrapped master key and verifies it can be unwrapped; the deploy
   aborts (before touching anything running) if it can't.
4. Merge to `main`, then **Actions → Deploy to EC2 → Run workflow**. (Prefer deploy-on-merge? Add
   `push: { branches: [main] }` under `on:`.)

Then open `https://ec2-13-250-133-109.ap-southeast-1.compute.amazonaws.com:9255`.

## Why it can't break the existing nginx
- Preflight aborts if 4255 / 7255 / 9255 are already used by something that isn't SportArena.
- Only `sites-available/sportarena` (and its symlink) is written. `nginx -t` runs before reload; if it fails, our site
  is removed and nothing is reloaded. Reload is graceful (`systemctl reload`), never a restart.
- The Postgres container is only created if absent and **never wiped** by a deploy; a credential mismatch aborts the
  deploy for a human to fix (myhealthpal's workflow recreates its DB in that case; we deliberately don't, because the
  volume holds encrypted user data).
- If anything fails before the cut-over, the previous code and running app stay in place.

## Security notes
- **In transit:** the site is HTTPS-only (TLS 1.2+). The API itself refuses plain HTTP in production (`426`) and trusts
  only nginx's `X-Forwarded-Proto` (`TRUST_PROXY=true`). Postgres is bound to localhost.
- **At rest:** personal fields are AES-256-GCM encrypted by the app; the master key is KMS-wrapped
  (`KEY_PROVIDER=aws-kms`) with an encryption context (`app=sportarena`). Losing the KMS key or `master.key.enc`
  makes the data unreadable — **back up `/var/lib/sportarena/master.key.enc`** and never delete the KMS key.
- **Certificate:** the first deploy generates a **self-signed** certificate, so browsers show a one-time warning and
  the *native mobile app* can't connect until there is a trusted certificate. Next step: point a domain at the host
  and use Let's Encrypt on 80/443 (as myhealthpal does with `configure-domain.sh`), then swap the
  `ssl_certificate` lines in the site file. Mobile builds then set `EXPO_PUBLIC_API_URL=https://<your-domain>`.

## Operating it
```bash
pm2 logs sportarena-api
sudo docker logs sportarena-postgres
psql "$(grep ^DATABASE_URL ~/sportarena/.env | cut -d= -f2-)"   # DB shell (on the host)
sudo nginx -t && sudo systemctl reload nginx
```

## Rehearsed locally
The topology (nginx TLS → API in `NODE_ENV=production` with `TRUST_PROXY`, same-origin web build) was exercised
end to end before this was written: HTTPS health/API/MCP through nginx, direct plain-HTTP to the API → `426`, SPA
fallback, 404 on missing hashed assets, and a browser signup over TLS with the app calling its own origin.
It could not be run against the real EC2 host/KMS from the development sandbox, so the first workflow run is the
real test — it fails safe (see above).
