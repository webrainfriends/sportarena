# Deploying to EC2 (side by side with myhealthpal)

SportArena deploys to the **same EC2 host** as myhealthpal using the same mechanism (GitHub Actions → SSH → pm2 +
Docker Postgres + nginx) and the same credentials. Everything it creates is namespaced, so existing apps are untouched.

| Thing | SportArena | Notes |
|---|---|---|
| Public site (nginx) | **9255** (plain HTTP for now; HTTPS via `ENABLE_TLS`) | own file `/etc/nginx/sites-available/sportarena`; other sites are never edited |
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
4. **Settings → General → Default branch → `main`.** (GitHub only shows the manual *Run workflow* button for workflows on the default branch.)
5. Merging to `main` deploys automatically; or run **Actions → Deploy to EC2 → Run workflow** by hand.

Then open **http://13.250.133.109:9255**.

## Why it can't break the existing nginx
- Preflight aborts if 4255 / 7255 / 9255 are already used by something that isn't SportArena.
- Only `sites-available/sportarena` (and its symlink) is written. `nginx -t` runs before reload; if it fails, our site
  is removed and nothing is reloaded. Reload is graceful (`systemctl reload`), never a restart.
- The Postgres container is only created if absent and **never wiped** by a deploy; a credential mismatch aborts the
  deploy for a human to fix (myhealthpal's workflow recreates its DB in that case; we deliberately don't, because the
  volume holds encrypted user data).
- If anything fails before the cut-over, the previous code and running app stay in place.

## Security notes
- **⚠️ In transit — currently plain HTTP.** `ENABLE_TLS: "false"` in `deploy.yml` serves the site over HTTP on 9255, so
  passwords, personal data and tokens cross the internet unencrypted until TLS is on. Treat this as demo/testing only:
  don't let real users sign up. The API only accepts HTTP in production because the deploy sets
  `ALLOW_INSECURE_HTTP=true` (it logs a warning at start-up, and HSTS is switched off so a later move to TLS isn't blocked).
- **Switching to HTTPS:** set `ENABLE_TLS: "true"` in `deploy.yml` and redeploy. nginx then serves TLS 1.2+ on the same
  port with a self-signed certificate (browser warning once; the native mobile app won't connect to it), and the API
  goes back to refusing plain HTTP (`426`). The real fix is a domain + Let's Encrypt (as myhealthpal does with
  `configure-domain.sh`) and then `EXPO_PUBLIC_API_URL=https://<your-domain>` for mobile builds.
- **At rest (unaffected):** personal fields are AES-256-GCM encrypted by the app; the master key is KMS-wrapped
  (`KEY_PROVIDER=aws-kms`) with an encryption context (`app=sportarena`). Losing the KMS key or `master.key.enc`
  makes the data unreadable — **back up `/var/lib/sportarena/master.key.enc`** and never delete the KMS key.
- Postgres is bound to localhost and the API is reachable only through nginx.

## Authorising the deploy key without logging in (EC2 Instance Connect)
An EC2 key pair is only installed when an instance is *launched*, so a new `.pem` is rejected by an existing instance.
The workflow fixes that itself: **Test SSH access** → if it fails and the AWS secrets exist, **Authorize deploy key on the
instance** looks up the instance by its public IP, pushes the key's public half with EC2 Instance Connect (valid 60 s),
connects, appends it to `~ubuntu/.ssh/authorized_keys` (idempotent) and verifies. Later runs connect normally.
- Needs repo secrets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (same as myhealthpal's AWS workflow), whose IAM user allows
  `ec2:DescribeInstances` and `ec2-instance-connect:SendSSHPublicKey` on the instance (the instance needs the
  `ec2-instance-connect` package, default on Ubuntu AMIs).
- Without them, the run stops with a message saying exactly this. The key then has to be one the instance already trusts.
- The authorised key gives `ubuntu` access to the whole host, like myhealthpal's. Never commit a `.pem`; keep it only in the `EC2_SSH_KEY` secret.

## Troubleshooting the SSH step
The workflow's first step, **Check SSH key**, validates `EC2_SSH_KEY` and prints its public fingerprint.
- `ssh: unable to authenticate ... [none publickey]` while that step says *Key OK*: the key is well-formed but is **not
  the one the instance trusts for `ubuntu`**. Use the exact key `myhealthpal` deploys with, and compare fingerprints:
  on the instance run `ssh-keygen -lf ~/.ssh/authorized_keys`, and locally `ssh-keygen -lf key.pem`
  (the fingerprint printed by the step must appear in that list).
- The step fails with a message: the secret is empty, truncated, a public key/`.ppk`, or passphrase-protected. Re-paste the
  whole `.pem` including the BEGIN/END lines.
- Test locally first: `ssh -i key.pem ubuntu@13.250.133.109`.

## Operating it
```bash
pm2 logs sportarena-api
sudo docker logs sportarena-postgres
psql "$(grep ^DATABASE_URL ~/sportarena/.env | cut -d= -f2-)"   # DB shell (on the host)
sudo nginx -t && sudo systemctl reload nginx
```

## Rehearsed locally
The topology (nginx → API in `NODE_ENV=production` with `TRUST_PROXY`, same-origin web build) was exercised end to
end in both modes: plain HTTP (health/API/MCP/web through nginx, browser signup) and TLS (same checks, plus direct
plain-HTTP to the API → `426`, SPA fallback, 404 on missing hashed assets).
It could not be run against the real EC2 host/KMS from the development sandbox, so the first workflow run is the
real test — it fails safe (see above).
