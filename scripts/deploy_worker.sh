#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$(cd "$SCRIPT_DIR/../worker" && pwd)"
ENV_FILE="$(cd "$SCRIPT_DIR/.." && pwd)/.env"

SECRET_NAMES=(
  MAGIC_LINK_SECRET
  PHONE_TOKEN_SECRET
  STUDENT_TOKEN_SECRET
  GALLERY_SCOPE_TOKEN_SECRET
  INTERNAL_API_SECRET
  FRAPPE_BASE_URL
  FRAPPE_API_KEY
  FRAPPE_API_SECRET
  GCS_SERVICE_ACCOUNT_JSON
  AI_PROVIDER_API_KEY
  BQ_SERVICE_ACCOUNT_JSON
  BQ_PROJECT_ID
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
)

usage() {
  cat <<'EOF'
Usage: deploy_worker.sh [options]

Options:
  --secrets
  --deploy
  --skip-typecheck
  --dry-run-only
  --patch-toml
  -h, --help
EOF
}

require_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: .env not found at $ENV_FILE" >&2
    exit 1
  fi
}

load_env() {
  require_env_file
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

push_secrets() {
  load_env
  cd "$WORKER_DIR"

  local missing=()
  for key in "${SECRET_NAMES[@]}"; do
    local value="${!key:-}"
    if [ -z "$value" ]; then
      missing+=("$key")
      continue
    fi
    printf '%s' "$value" | npx wrangler secret put "$key" >/dev/null
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    printf '%s\n' "${missing[@]}" >&2
  fi

  npx wrangler secret list
}

patch_toml() {
  load_env
  cd "$WORKER_DIR"

  local toml="wrangler.toml"
  local tmp
  tmp="$(mktemp)"

  CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-}" \
  CF_D1_DATABASE_ID="${CF_D1_DATABASE_ID:-}" \
  CF_R2_ACCOUNT_ID="${CF_R2_ACCOUNT_ID:-}" \
  python3 - "$toml" "$tmp" <<'PYEOF'
import os, re, sys

src_path, dst_path = sys.argv[1], sys.argv[2]
with open(src_path) as f:
    content = f.read()

replacements = {
    "database_id": os.environ.get("CF_D1_DATABASE_ID", ""),
    "R2_ACCOUNT_ID": os.environ.get("CF_R2_ACCOUNT_ID", ""),
}

for key, value in replacements.items():
    pattern = re.compile(rf'^({re.escape(key)}\s*=\s*)""', re.MULTILINE)
    content = pattern.sub(lambda m: f'{m.group(1)}"{value}"', content)

with open(dst_path, "w") as f:
    f.write(content)
PYEOF

  mv "$tmp" "$toml"

  if [ -n "${CF_ACCOUNT_ID:-}" ]; then
    export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"
  fi
}

run_deploy() {
  local skip_typecheck="$1"
  local dry_run_only="$2"

  cd "$WORKER_DIR"

  npm install

  if [ "$skip_typecheck" != "true" ]; then
    npx tsc --noEmit
  fi

  npx wrangler deploy --dry-run

  if [ "$dry_run_only" = "true" ]; then
    return 0
  fi

  npx wrangler deploy
}

DO_SECRETS=false
ALSO_DEPLOY=false
SKIP_TYPECHECK=false
DRY_RUN_ONLY=false
PATCH_TOML=false

while [ $# -gt 0 ]; do
  case "$1" in
    --secrets) DO_SECRETS=true ;;
    --deploy) ALSO_DEPLOY=true ;;
    --skip-typecheck) SKIP_TYPECHECK=true ;;
    --dry-run-only) DRY_RUN_ONLY=true ;;
    --patch-toml) PATCH_TOML=true ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
  shift
done

if [ "$PATCH_TOML" = "true" ]; then
  patch_toml
fi

if [ "$DO_SECRETS" = "true" ]; then
  push_secrets
  if [ "$ALSO_DEPLOY" != "true" ]; then
    exit 0
  fi
fi

run_deploy "$SKIP_TYPECHECK" "$DRY_RUN_ONLY"