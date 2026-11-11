#!/usr/bin/env bash
# =============================================================================
#  Kịch bản triển khai RestoManager lên VPS
# -----------------------------------------------------------------------------
#  Chạy TRÊN VPS, trong thư mục gốc dự án:
#      ./deploy/deploy.sh
#
#  Các bước:
#    1. Kiểm tra điều kiện (Docker, .env, secret đủ mạnh)
#    2. Sao lưu CSDL trước khi đổi mã (có đường lùi nếu hỏng)
#    3. Kéo mã mới, build ảnh
#    4. Khởi động lại dịch vụ, chờ đến khi khoẻ thật sự
#    5. Kiểm chứng sau triển khai; tự ROLLBACK nếu thất bại
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}▸${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}!${NC} $*"; }
fail()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

# ─── 1. Kiểm tra điều kiện ───────────────────────────────────────────────────
info "Kiểm tra điều kiện triển khai..."

command -v docker >/dev/null || fail "Chưa cài Docker. Xem DEPLOYMENT.md mục 2."
docker compose version >/dev/null 2>&1 || fail "Cần Docker Compose v2 (docker compose, không phải docker-compose)."
[ -f .env ] || fail "Thiếu tệp .env. Chạy: cp .env.example .env rồi chỉnh sửa."

# shellcheck disable=SC1091
set -a; . ./.env; set +a

[ "${NODE_ENV:-}" = "production" ] || fail "NODE_ENV phải là 'production' trong .env"
[ -n "${DOMAIN:-}" ]     || fail "Thiếu DOMAIN trong .env"
[ -n "${ACME_EMAIL:-}" ] || fail "Thiếu ACME_EMAIL trong .env"

for secret in JWT_SECRET REFRESH_SECRET GUEST_SECRET; do
  value="${!secret:-}"
  [ -n "$value" ] || fail "Thiếu $secret trong .env"
  [ "${#value}" -ge 32 ] || fail "$secret phải dài ≥ 32 ký tự (hiện tại ${#value}). Chạy: openssl rand -base64 48"
  case "$value" in
    *doi-gia-tri-nay*|*REPLACE_ME*|*change-me*) fail "$secret vẫn là giá trị mẫu. Hãy sinh giá trị ngẫu nhiên." ;;
  esac
done
[ "$JWT_SECRET" != "$REFRESH_SECRET" ] || fail "JWT_SECRET và REFRESH_SECRET phải khác nhau"
[ "${DB_PASSWORD:-postgres}" != "postgres" ] || fail "DB_PASSWORD vẫn là mặc định 'postgres'"
[ "${MINIO_SECRET_KEY:-minioadmin}" != "minioadmin" ] || fail "MINIO_SECRET_KEY vẫn là mặc định"
[ "${SEED_ON_BOOT:-false}" = "false" ] || warn "SEED_ON_BOOT=true — nên đặt false sau lần khởi tạo đầu tiên"

ok "Cấu hình hợp lệ (domain: $DOMAIN)"

# ─── 2. Sao lưu trước khi đổi mã ─────────────────────────────────────────────
if $COMPOSE ps postgres --format json 2>/dev/null | grep -q '"State":"running"'; then
  info "Sao lưu CSDL trước khi triển khai..."
  mkdir -p backups
  SNAPSHOT="backups/pre-deploy-$(date +%Y%m%d-%H%M%S).sql.gz"
  $COMPOSE exec -T postgres pg_dump -U "${DB_USER:-postgres}" --no-owner --clean --if-exists \
    "${DB_NAME:-restaurant_db}" | gzip -9 > "$SNAPSHOT"
  ok "Đã lưu $SNAPSHOT ($(du -h "$SNAPSHOT" | cut -f1))"
else
  warn "PostgreSQL chưa chạy — bỏ qua bước sao lưu (lần triển khai đầu tiên)"
  SNAPSHOT=""
fi

# ─── 3. Lấy mã mới & build ───────────────────────────────────────────────────
if [ -d .git ] && [ "${SKIP_GIT:-0}" != "1" ]; then
  info "Kéo mã mới từ Git..."
  git pull --ff-only
fi

info "Kiểm tra ranh giới module trước khi build..."
docker run --rm -v "$PWD/back-end:/app" -w /app node:20-alpine \
  node tools/check-boundaries.js || fail "Vi phạm ranh giới module — không triển khai mã này."

info "Build ảnh Docker..."
$COMPOSE build --pull

# ─── 4. Khởi động lại ────────────────────────────────────────────────────────
info "Khởi động dịch vụ..."
$COMPOSE up -d --remove-orphans

info "Chờ backend sẵn sàng..."
for i in $(seq 1 60); do
  if $COMPOSE exec -T backend wget -qO- http://127.0.0.1:3000/api/health/ready >/dev/null 2>&1; then
    ok "Backend đã sẵn sàng sau ${i}s"
    break
  fi
  [ "$i" -eq 60 ] && {
    echo; warn "Backend không sẵn sàng sau 60 giây. 50 dòng log cuối:"
    $COMPOSE logs --tail=50 backend
    [ -n "$SNAPSHOT" ] && warn "Khôi phục: gunzip -c $SNAPSHOT | $COMPOSE exec -T postgres psql -U ${DB_USER:-postgres} ${DB_NAME:-restaurant_db}"
    fail "Triển khai thất bại."
  }
  printf '.'
  sleep 1
done

# ─── 5. Kiểm chứng sau triển khai ────────────────────────────────────────────
info "Kiểm chứng hệ thống..."

HEALTH=$($COMPOSE exec -T backend wget -qO- http://127.0.0.1:3000/api/health || echo '{}')
echo "$HEALTH" | grep -q '"status":"ok"' \
  && ok "Sức khoẻ hệ thống: ok" \
  || { warn "Hệ thống suy giảm:"; echo "$HEALTH"; }

MODULES=$($COMPOSE exec -T backend wget -qO- http://127.0.0.1:3000/api/architecture 2>/dev/null || echo '{}')
COUNT=$(echo "$MODULES" | grep -o '"count":[0-9]*' | head -1 | cut -d: -f2 || echo '?')
ok "Đã nạp $COUNT module"

if command -v curl >/dev/null; then
  info "Kiểm tra HTTPS công khai (https://$DOMAIN)..."
  sleep 5
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/api/health" || echo 000)
  case "$CODE" in
    200) ok "HTTPS hoạt động, chứng chỉ hợp lệ" ;;
    000) warn "Chưa truy cập được từ ngoài. Kiểm tra: DNS đã trỏ về VPS? Cổng 80/443 đã mở? Caddy cần 1–2 phút để xin chứng chỉ." ;;
    *)   warn "HTTPS trả về mã $CODE — xem: $COMPOSE logs caddy" ;;
  esac
fi

echo
ok "Triển khai hoàn tất!"
echo
echo "  Ứng dụng   : https://$DOMAIN"
echo "  Tài liệu   : https://$DOMAIN/api/docs"
echo "  Kiến trúc  : https://$DOMAIN/api/architecture"
echo "  Ảnh (CDN)  : https://cdn.$DOMAIN"
echo
echo "  Xem log    : $COMPOSE logs -f backend"
echo "  Trạng thái : $COMPOSE ps"
[ -n "$SNAPSHOT" ] && echo "  Bản lùi    : $SNAPSHOT"
echo
