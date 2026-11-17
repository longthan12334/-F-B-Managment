#!/usr/bin/env bash
# =============================================================================
#  Triển khai một phiên bản image lên VPS — có sao lưu trước và tự rollback
# -----------------------------------------------------------------------------
#  Dùng:
#    ./scripts/release.sh <tag> [backend-image] [frontend-image]
#  Ví dụ (GitHub Actions gọi đúng lệnh này qua SSH):
#    ./scripts/release.sh sha-4f2c1ab ghcr.io/ten-ban/restomanager-backend ghcr.io/ten-ban/restomanager-frontend
#  Bỏ trống image thì dùng lại image trong release.env.
#
#  Các bước:
#    1. Kiểm tra .env + chứng chỉ (scripts/check-env.sh)
#    2. Kéo image mới
#    3. Sao lưu CSDL vào backups/pre-release-*.dump (nếu CSDL đang chạy)
#    4. `docker compose up -d`
#    5. Chờ backend báo khoẻ (CSDL + kho ảnh) và frontend trả /healthz
#    6. Thành công → ghi release.env. Thất bại → chạy lại tag cũ (rollback).
#
#  ⚠ Rollback chỉ đổi image. Nếu phiên bản mới đã chạy migration làm đổi cấu
#    trúc CSDL theo cách bản cũ không hiểu, khôi phục từ bản pre-release-*.dump
#    (xem DEPLOY-CLOUDFLARE.md, mục Khôi phục).
# =============================================================================
set -Eeuo pipefail
cd "$(dirname "$0")/.."

TAG="${1:?Thiếu tag image, ví dụ: sha-4f2c1ab}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"

log() { echo "[release] $(date '+%F %T') $*"; }
die() { log "LỖI: $*"; exit 1; }

PREV_TAG=""; PREV_BACKEND=""; PREV_FRONTEND=""
if [[ -f release.env ]]; then
  PREV_TAG="$(sed -n 's/^IMAGE_TAG=//p' release.env)"
  PREV_BACKEND="$(sed -n 's/^BACKEND_IMAGE=//p' release.env)"
  PREV_FRONTEND="$(sed -n 's/^FRONTEND_IMAGE=//p' release.env)"
fi
NEW_BACKEND="${2:-$PREV_BACKEND}"
NEW_FRONTEND="${3:-$PREV_FRONTEND}"
[[ -n "$NEW_BACKEND" && -n "$NEW_FRONTEND" ]] || die "Chưa biết tên image (truyền tham số 2, 3 ở lần đầu)."

[[ "$TAG" =~ ^[A-Za-z0-9_.-]+$ ]] || die "Tag không hợp lệ: $TAG"

port_of() { sed -n "s/^$1=//p" .env | tail -n1 | tr -d '"'"'"; }
BACKEND_PORT="$(port_of BACKEND_PORT)"; BACKEND_PORT="${BACKEND_PORT:-3000}"
FRONTEND_PORT="$(port_of FRONTEND_PORT)"; FRONTEND_PORT="${FRONTEND_PORT:-8080}"

dc() {
  BACKEND_IMAGE="$CUR_BACKEND" FRONTEND_IMAGE="$CUR_FRONTEND" IMAGE_TAG="$CUR_TAG" \
    docker compose -f compose.yml "$@"
}

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) body
  while (( SECONDS < deadline )); do
    # /api/health kiểm tra cả CSDL và kho ảnh R2 (chỉ gọi được từ chính VPS)
    if body="$(curl -fsS --max-time 5 "http://127.0.0.1:${BACKEND_PORT}/api/health" 2>/dev/null)" \
       && curl -fsS --max-time 5 "http://127.0.0.1:${FRONTEND_PORT}/healthz" >/dev/null 2>&1; then
      log "Khoẻ: $(echo "$body" | grep -o '"version":"[^"]*"' || true)"
      return 0
    fi
    sleep 3
  done
  return 1
}

log "Bắt đầu triển khai $TAG (đang chạy: ${PREV_TAG:-chưa có})"
./scripts/check-env.sh .env || die "Cấu hình chưa đạt — dừng, chưa thay đổi gì."
mkdir -p backups

CUR_TAG="$TAG"; CUR_BACKEND="$NEW_BACKEND"; CUR_FRONTEND="$NEW_FRONTEND"
log "Kéo image $NEW_BACKEND:$TAG và $NEW_FRONTEND:$TAG"
dc pull backend frontend || die "Không kéo được image (đã docker login ghcr.io chưa? tag có tồn tại không?)"

if [[ -n "$(dc ps --status running -q postgres 2>/dev/null)" ]]; then
  snap="backups/pre-release-$(date +%Y%m%d-%H%M%S)-${PREV_TAG:-none}.dump"
  log "Sao lưu CSDL trước khi đổi phiên bản → $snap"
  dc exec -T postgres sh -c 'pg_dump --format=custom --no-owner -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$snap.part" \
    || { rm -f "$snap.part"; die "pg_dump thất bại — dừng, chưa thay đổi gì."; }
  [[ $(wc -c < "$snap.part") -gt 1024 ]] || { rm -f "$snap.part"; die "Bản sao lưu quá nhỏ — dừng."; }
  mv "$snap.part" "$snap"
  # Giữ 10 bản pre-release gần nhất
  ls -1t backups/pre-release-*.dump 2>/dev/null | tail -n +11 | xargs -r rm -f
else
  log "CSDL chưa chạy (lần triển khai đầu) — bỏ qua sao lưu."
fi

log "Khởi động phiên bản mới"
dc up -d --remove-orphans

if wait_healthy; then
  printf 'IMAGE_TAG=%s\nBACKEND_IMAGE=%s\nFRONTEND_IMAGE=%s\nDEPLOYED_AT=%s\n' \
    "$TAG" "$NEW_BACKEND" "$NEW_FRONTEND" "$(date -Iseconds)" > release.env.tmp
  mv release.env.tmp release.env
  docker image prune -f >/dev/null 2>&1 || true
  log "THÀNH CÔNG: đang chạy $TAG"
  exit 0
fi

log "Phiên bản $TAG không khoẻ sau ${HEALTH_TIMEOUT}s. Log backend gần nhất:"
dc logs --tail=60 backend || true

if [[ -z "$PREV_TAG" ]]; then
  die "Không có phiên bản trước để rollback. Xem log ở trên."
fi

log "ROLLBACK về $PREV_TAG"
CUR_TAG="$PREV_TAG"; CUR_BACKEND="$PREV_BACKEND"; CUR_FRONTEND="$PREV_FRONTEND"
dc up -d --remove-orphans
if wait_healthy; then
  die "Đã rollback về $PREV_TAG và hệ thống khoẻ lại. Phiên bản $TAG KHÔNG được triển khai."
fi
die "Rollback về $PREV_TAG cũng không khoẻ — cần xử lý tay (xem ./scripts/dc.sh logs)."
