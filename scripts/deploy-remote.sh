#!/usr/bin/env bash
# Runs ON the EC2 host (copied and executed by .github/workflows/deploy.yml). Configuration arrives as environment
# variables: APP_DIR BRANCH REPO_URL APP_PORT NGINX_PORT DB_PORT ENABLE_TLS PUBLIC_HOST PUBLIC_IP KMS_KEY_ID KMS_REGION (+ optional STRIPE_*/PAYPAL_*/PAYMENT_CURRENCY).
# Idempotent; see docs/deployment.md.
set -Eeuo pipefail
# Persist why a deploy failed: the SSH session can drop its last output lines on a non-zero exit, so the
# 'Server report' step prints these files from a fresh session.
rm -f /tmp/sportarena-deploy-error.log /tmp/sportarena-nginx-error.log /tmp/sportarena-site.rejected
trap 'rc=$?; echo "deploy failed (exit $rc) at line $LINENO: $BASH_COMMAND" | tee /tmp/sportarena-deploy-error.log >&2; sleep 2' ERR

if [ ! -d "$APP_DIR/.git" ]; then
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
APP_ROOT="$(pwd)"
PREV_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"   # untracked .env is preserved

abort_deploy() {
  echo "::error::$1" | tee /tmp/sportarena-deploy-error.log
  if [ -n "$PREV_SHA" ]; then
    echo "[deploy] restoring previous code ($PREV_SHA); the running app was not touched"
    git reset --hard "$PREV_SHA"
  fi
  sleep 2
  exit 1
}

# ---- preflight: nothing below changes the host until these pass ----
if [ -z "${KMS_KEY_ID:-}" ]; then
  abort_deploy "KMS_KEY_ID secret is not set (Settings -> Secrets and variables -> Actions)."
fi
KMS_KEY_ID="$(printf '%s' "$KMS_KEY_ID" | tr -d '\r\n' | xargs)"
KMS_REGION="$(printf '%s' "${KMS_REGION:-ap-southeast-1}" | tr -d '\r\n' | xargs)"

port_in_use() { ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }
if port_in_use "$APP_PORT" && ! pm2 describe sportarena-api >/dev/null 2>&1; then
  abort_deploy "Port $APP_PORT is already used by something that is not sportarena-api. Pick another APP_PORT."
fi
if port_in_use "$DB_PORT" && ! sudo docker inspect sportarena-postgres >/dev/null 2>&1; then
  abort_deploy "Port $DB_PORT is already used by something that is not sportarena-postgres. Pick another DB_PORT."
fi
if port_in_use "$NGINX_PORT" && [ ! -e /etc/nginx/sites-enabled/sportarena ]; then
  abort_deploy "Port $NGINX_PORT is already used by something that is not the sportarena nginx site."
fi

# ---- tooling (each is a no-op when the host already has it) ----
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "${USER:-ubuntu}"
fi
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
if ! command -v pm2 >/dev/null 2>&1; then sudo npm install -g pm2; fi
if ! command -v psql >/dev/null 2>&1; then
  sudo apt-get update && sudo apt-get install -y postgresql-client
fi
if ! command -v nginx >/dev/null 2>&1; then
  sudo apt-get update && sudo apt-get install -y nginx
  sudo systemctl enable --now nginx
fi
if [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
  echo "[deploy] no swap found - creating 2G /swapfile"
  if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
    sudo chmod 600 /swapfile; sudo mkswap /swapfile
  fi
  sudo swapon /swapfile || true
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "[deploy] installing dependencies"
NODE_OPTIONS=--max-old-space-size=1536 npm ci

# ---- master key: wrapped by KMS, created once ----
echo "[deploy] security preflight: AWS KMS"
KEY_DIR=/var/lib/sportarena
sudo mkdir -p "$KEY_DIR"
sudo chown "$(id -un):$(id -gn)" "$KEY_DIR"
sudo chmod 700 "$KEY_DIR"
(cd apps/api && KEY_PROVIDER=aws-kms KMS_KEY_ID="$KMS_KEY_ID" KMS_REGION="$KMS_REGION" MASTER_KEY_FILE="$KEY_DIR/master.key.enc" \
  node scripts/kms-init.js) || abort_deploy "This server cannot use the KMS key (see [kms] lines above)."

# ---- web build (same-origin API: nginx proxies /api and /mcp) ----
echo "[deploy] building the app for web"
(cd apps/app && NODE_OPTIONS=--max-old-space-size=1536 CI=1 EXPO_PUBLIC_API_URL= npx expo export --platform web --output-dir dist) \
  || abort_deploy "Web build failed - previous version still running."
WEB_ROOT=/var/www/sportarena-web
sudo rm -rf "$WEB_ROOT"; sudo mkdir -p "$WEB_ROOT"
sudo cp -r apps/app/dist/. "$WEB_ROOT"/

# ---- Postgres container: created once, never wiped by a deploy ----
DB_CONTAINER=sportarena-postgres
ENV_FILE="$APP_ROOT/.env"
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
set_env() {
  grep -q "^$1=" "$ENV_FILE" || echo "$1=" >> "$ENV_FILE"
  sed -i "s#^$1=.*#$1=$2#" "$ENV_FILE"
}
env_val() { grep "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }

if ! sudo docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
  echo "[deploy] creating $DB_CONTAINER on 127.0.0.1:${DB_PORT}"
  DB_PASS_VAL=$(openssl rand -hex 16)
  sudo docker run -d --name "$DB_CONTAINER" --restart unless-stopped \
    -e POSTGRES_DB=sportarena -e POSTGRES_USER=sportarena -e POSTGRES_PASSWORD="${DB_PASS_VAL}" \
    -p 127.0.0.1:${DB_PORT}:5432 \
    -v sportarena_pgdata:/var/lib/postgresql/data \
    postgres:16-alpine
  set_env DATABASE_URL "postgres://sportarena:${DB_PASS_VAL}@127.0.0.1:${DB_PORT}/sportarena"
fi
ready=0
for i in $(seq 1 30); do
  if sudo docker exec "$DB_CONTAINER" pg_isready -U sportarena >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || { sudo docker logs --tail 50 "$DB_CONTAINER"; abort_deploy "$DB_CONTAINER did not become ready."; }
# Never recreate automatically: the volume holds encrypted data, so a credential mismatch is a human decision.
if ! PGCONNECT_TIMEOUT=5 psql "$(env_val DATABASE_URL)" -c '\q' >/dev/null 2>&1; then
  abort_deploy "Cannot connect to $DB_CONTAINER with DATABASE_URL in $ENV_FILE. Not recreating it (data would be lost). Fix the credentials manually."
fi

# ---- app environment ----
set_env NODE_ENV production
set_env PORT "$APP_PORT"
set_env TRUST_PROXY true
if [ "${ENABLE_TLS:-false}" = "true" ]; then SCHEME=https; set_env ALLOW_INSECURE_HTTP false; else SCHEME=http; set_env ALLOW_INSECURE_HTTP true
  echo "::warning::Serving over plain HTTP (ENABLE_TLS=false): personal data is not encrypted in transit. Enable TLS before real users sign up."
fi
set_env CORS_ORIGINS "${SCHEME}://${PUBLIC_IP}:${NGINX_PORT},${SCHEME}://${PUBLIC_HOST}:${NGINX_PORT}"
set_env KEY_PROVIDER aws-kms
set_env KMS_KEY_ID "$KMS_KEY_ID"
set_env KMS_REGION "$KMS_REGION"
set_env MASTER_KEY_FILE "$KEY_DIR/master.key.enc"
# Uploaded venue photos/videos live outside the repo checkout and the web root, so no deploy ever touches them.
MEDIA_DIR="$KEY_DIR/media"
sudo mkdir -p "$MEDIA_DIR"; sudo chown "$(id -un):$(id -gn)" "$MEDIA_DIR"
set_env MEDIA_DIR "$MEDIA_DIR"
# Payments: only written when provided, so a deploy without keys never wipes keys set earlier.
for v in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET PAYPAL_WEBHOOK_ID PAYPAL_ENV PAYMENT_CURRENCY; do
  val="$(printf '%s' "${!v:-}" | tr -d '\r\n' | xargs)"
  [ -n "$val" ] && set_env "$v" "$val"
done
# Generated once and never rotated by a deploy (that would sign everyone out).
if [ -z "$(env_val SPORTARENA_JWT_SECRET)" ]; then
  echo "[deploy] generating SPORTARENA_JWT_SECRET (first deploy only)"
  set_env SPORTARENA_JWT_SECRET "$(openssl rand -hex 48)"
fi

# ---- migrate + (re)start the API ----
(cd apps/api && npm run migrate)
pm2 delete sportarena-api >/dev/null 2>&1 || true
(cd apps/api && pm2 start src/server.js --name sportarena-api --node-args="--env-file=$ENV_FILE")
pm2 save
ok=0
for i in $(seq 1 30); do
  if curl -fs "http://127.0.0.1:${APP_PORT}/health" >/dev/null 2>&1; then ok=1; echo "[deploy] API healthy after ${i}s"; break; fi
  sleep 1
done
[ "$ok" -eq 1 ] || { pm2 logs sportarena-api --lines 40 --nostream || true; abort_deploy "API did not become healthy on $APP_PORT."; }

# ---- TLS (only when ENABLE_TLS=true): self-signed certificate until a real domain/cert exists ----
SSL_DIR=/etc/nginx/ssl/sportarena
if [ "${ENABLE_TLS:-false}" = "true" ]; then
  if [ ! -f "$SSL_DIR/fullchain.pem" ]; then
    echo "[deploy] generating a self-signed certificate for ${PUBLIC_HOST}"
    sudo mkdir -p "$SSL_DIR"
    sudo openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout "$SSL_DIR/privkey.pem" -out "$SSL_DIR/fullchain.pem" \
      -subj "/CN=${PUBLIC_HOST}" -addext "subjectAltName=DNS:${PUBLIC_HOST},IP:${PUBLIC_IP}" >/dev/null 2>&1
    sudo chmod 600 "$SSL_DIR/privkey.pem"
  fi
  LISTEN_DIRECTIVE="${NGINX_PORT} ssl"
  SSL_CONF="ssl_certificate     ${SSL_DIR}/fullchain.pem;
    ssl_certificate_key ${SSL_DIR}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;"
else
  LISTEN_DIRECTIVE="${NGINX_PORT}"
  SSL_CONF="# TLS disabled (ENABLE_TLS=false)"
fi

# ---- nginx: our own site file only; other sites are never edited ----
echo "[deploy] configuring nginx on port ${NGINX_PORT}"
SITE=/etc/nginx/sites-available/sportarena
cat <<NGINX | sudo tee "$SITE" >/dev/null
server {
    listen ${LISTEN_DIRECTIVE};
    server_name _;
    ${SSL_CONF}

    client_max_body_size 2m;

    # large uploads (venue videos): streamed straight to the API, never buffered by nginx
    location ~ ^/api/v1/venues/[0-9a-f-]+/media$ {
        client_max_body_size 160m;
        proxy_request_buffering off;
        proxy_read_timeout 600s;
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    location = /mcp {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
    location = /health {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    root ${WEB_ROOT};
    location /_expo/ {
        try_files \$uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
    location / {
        try_files \$uri \$uri/ /index.html;
        add_header Cache-Control "no-cache";
    }
}
NGINX
sudo ln -sf "$SITE" /etc/nginx/sites-enabled/sportarena
if ! NGINX_OUT="$(sudo nginx -t 2>&1)"; then
  echo "::error::nginx rejected the sportarena site - removing it; existing sites are unaffected"
  printf '%s\n' "$NGINX_OUT" | tee /tmp/sportarena-nginx-error.log
  sudo cp "$SITE" /tmp/sportarena-site.rejected
  sudo chmod 644 /tmp/sportarena-site.rejected
  sudo rm -f /etc/nginx/sites-enabled/sportarena "$SITE"
  sudo nginx -t
  sleep 2
  exit 1
fi
sudo systemctl reload nginx      # graceful: existing connections/sites keep working

# nginx needs a moment after a graceful reload before the new listener answers, so retry instead of checking once.
# The check covers all three routes: API health, the web app at / and an API call that hits the database.
# No code rollback past this point: nginx already serves the new site.
check_site() {
  local base="${SCHEME}://127.0.0.1:${NGINX_PORT}" b
  curl -fsk "$base/health" >/dev/null 2>&1 || return 1
  b="$(curl -fsk "$base/" 2>/dev/null || true)"; [[ "${b,,}" == *"<html"* ]] || return 1
  b="$(curl -fsk "$base/api/v1/sports" 2>/dev/null || true)"; [[ "$b" == *'"slug"'* ]] || return 1
}
site_ok=0
for i in $(seq 1 30); do
  if check_site; then site_ok=1; echo "[deploy] site healthy through nginx after ${i}s"; break; fi
  sleep 1
done
if [ "$site_ok" -ne 1 ]; then
  echo "::error::Site is not reachable through nginx on ${NGINX_PORT} (30s)." | tee /tmp/sportarena-deploy-error.log
  sudo nginx -t 2>&1 | tail -3 || true
  sleep 2
  exit 1
fi
echo "Deployed. ${SCHEME}://${PUBLIC_IP}:${NGINX_PORT}"
[ "$SCHEME" = "https" ] || echo "NOTE: plain HTTP - not encrypted in transit. Set ENABLE_TLS to \"true\" in deploy.yml to switch to HTTPS."
