#!/usr/bin/env bash
# =============================================================================
#  docker compose đã nạp sẵn release.env (image + tag đang chạy)
# -----------------------------------------------------------------------------
#  Dùng thay cho `docker compose` trên VPS:
#      ./scripts/dc.sh ps
#      ./scripts/dc.sh logs -f --tail=100 backend
#      ./scripts/dc.sh exec postgres psql -U postgres restaurant_db
#      ./scripts/dc.sh --profile offsite up -d
#  release.env do scripts/release.sh ghi sau mỗi lần triển khai thành công.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f release.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source ./release.env
  set +a
fi

exec docker compose -f compose.yml "$@"
