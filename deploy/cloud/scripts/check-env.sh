#!/usr/bin/env bash
# =============================================================================
#  Kiểm tra .env và chứng chỉ trước khi chạy production
# -----------------------------------------------------------------------------
#  Chạy:  ./scripts/check-env.sh [đường-dẫn-.env]
#  Thoát mã 1 nếu có lỗi chặn; cảnh báo không làm dừng.
#  scripts/release.sh tự gọi script này trước mỗi lần triển khai.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${1:-.env}"
CERT_DIR="${CERT_DIR:-certs}"
errors=0
warns=0

err()  { echo "  [LỖI]     $*"; errors=$((errors + 1)); }
warn() { echo "  [CẢNH BÁO] $*"; warns=$((warns + 1)); }
ok()   { echo "  [OK]      $*"; }

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Không thấy $ENV_FILE — chép từ env.example rồi điền giá trị." >&2
  exit 1
fi

# Đọc KEY=VALUE mà KHÔNG thực thi tệp (an toàn hơn `source`)
declare -A E=()
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
  key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
  if [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
  E["$key"]="$val"
done < "$ENV_FILE"

get() { echo "${E[$1]:-}"; }
PLACEHOLDER='doi-gia-tri-nay|change-?me|replace[-_ ]?me|placeholder|example|your[-_]?secret|^<.*>$|<[^>]*>'
is_placeholder() { [[ "$1" =~ $PLACEHOLDER ]] || echo "$1" | grep -qiE "$PLACEHOLDER"; }

echo "Kiểm tra $ENV_FILE"

# ── Biến bắt buộc ────────────────────────────────────────────────────────────
for k in DOMAIN ALLOWED_ORIGINS DB_PASSWORD JWT_SECRET REFRESH_SECRET GUEST_SECRET \
         STORAGE_DRIVER S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY S3_PUBLIC_URL; do
  v="$(get "$k")"
  if [[ -z "$v" ]]; then err "$k chưa đặt"
  elif is_placeholder "$v"; then err "$k vẫn là giá trị mẫu"
  fi
done

# ── Secret ───────────────────────────────────────────────────────────────────
for k in JWT_SECRET REFRESH_SECRET GUEST_SECRET; do
  v="$(get "$k")"
  [[ -n "$v" && ${#v} -lt 32 ]] && err "$k chỉ dài ${#v} ký tự (cần >= 32)"
done
j="$(get JWT_SECRET)"; r="$(get REFRESH_SECRET)"; g="$(get GUEST_SECRET)"
[[ -n "$j" && "$j" == "$r" ]] && err "JWT_SECRET trùng REFRESH_SECRET"
[[ -n "$j" && "$j" == "$g" ]] && err "JWT_SECRET trùng GUEST_SECRET"
[[ -n "$r" && "$r" == "$g" ]] && err "REFRESH_SECRET trùng GUEST_SECRET"

dbp="$(get DB_PASSWORD)"
if [[ -n "$dbp" ]]; then
  [[ "$dbp" == "postgres" || ${#dbp} -lt 16 ]] && err "DB_PASSWORD yếu (mặc định hoặc < 16 ký tự)"
fi

# ── Tên miền & CORS ──────────────────────────────────────────────────────────
domain="$(get DOMAIN)"
origins="$(get ALLOWED_ORIGINS)"
if [[ -n "$domain" ]]; then
  [[ "$domain" =~ ^https?:// ]] && err "DOMAIN chỉ ghi tên miền, không kèm http(s)://"
  [[ ",$origins," == *",https://$domain,"* ]] || err "ALLOWED_ORIGINS phải chứa https://$domain"
fi
[[ "$origins" == *"http://"* ]] && warn "ALLOWED_ORIGINS có nguồn http:// — production nên chỉ dùng https://"

ne="$(get NODE_ENV)"
[[ -n "$ne" && "$ne" != "production" ]] && warn "NODE_ENV=$ne trong .env bị compose ghi đè thành production"

# ── Tài khoản khởi tạo ───────────────────────────────────────────────────────
seed="$(get SEED_ON_BOOT)"
if [[ "${seed,,}" =~ ^(1|true|yes|on)$ ]]; then
  sp="$(get SEED_PASSWORD)"
  if [[ ${#sp} -lt 12 ]] || is_placeholder "$sp"; then
    err "SEED_ON_BOOT=true nhưng SEED_PASSWORD yếu/mẫu (cần >= 12 ký tự)"
  else
    warn "SEED_ON_BOOT=true — sau lần chạy đầu, đổi mật khẩu 3 tài khoản rồi đặt false"
  fi
fi

# ── Kho ảnh R2 ───────────────────────────────────────────────────────────────
drv="$(get STORAGE_DRIVER)"
pub="$(get S3_PUBLIC_URL)"
[[ -n "$pub" && ! "$pub" =~ ^https:// ]] && err "S3_PUBLIC_URL phải là https://..."
if [[ "$drv" == "r2" ]]; then
  ep="$(get S3_ENDPOINT)"
  [[ "$ep" =~ ^https?:// ]] && err "S3_ENDPOINT chỉ ghi host (<account-id>.r2.cloudflarestorage.com), không kèm https://"
  [[ -n "$ep" && ! "$ep" =~ \.r2\.cloudflarestorage\.com$ ]] && warn "S3_ENDPOINT không có dạng <account-id>.r2.cloudflarestorage.com"
  [[ "$(get S3_USE_SSL)" == "true" ]] || err "Với R2 cần S3_USE_SSL=true"
  [[ "$(get S3_PORT)" == "443" ]] || err "Với R2 cần S3_PORT=443"
  [[ "$(get S3_REGION)" == "auto" || "$(get S3_REGION)" == "us-east-1" ]] || warn "R2 dùng S3_REGION=auto"
  [[ "$pub" == *".r2.dev"* ]] && warn "S3_PUBLIC_URL dùng r2.dev — Cloudflare giới hạn tốc độ địa chỉ này, nên dùng custom domain"
elif [[ "$drv" == "minio" ]]; then
  warn "STORAGE_DRIVER=minio — compose này không chạy MinIO, ảnh sẽ không tải lên được"
fi

# ── Sao lưu ngoài máy chủ (tuỳ chọn) ─────────────────────────────────────────
if [[ -n "$(get BACKUP_R2_BUCKET)" ]]; then
  [[ "$(get BACKUP_R2_BUCKET)" == "$(get S3_BUCKET)" ]] && err "BACKUP_R2_BUCKET phải khác bucket ảnh (ảnh là công khai!)"
  for k in BACKUP_R2_ENDPOINT BACKUP_R2_ACCESS_KEY BACKUP_R2_SECRET_KEY; do
    v="$(get "$k")"; { [[ -z "$v" ]] || is_placeholder "$v"; } && err "$k chưa đặt (cần cho profile offsite)"
  done
else
  warn "Chưa cấu hình BACKUP_R2_* — bản sao lưu chỉ nằm trên chính VPS"
fi

# ── Chứng chỉ Origin CA ──────────────────────────────────────────────────────
crt="$CERT_DIR/origin.pem"; key="$CERT_DIR/origin.key"
if [[ ! -s "$crt" || ! -s "$key" ]]; then
  err "Thiếu $crt hoặc $key (Cloudflare → SSL/TLS → Origin Server → Create Certificate)"
elif command -v openssl >/dev/null 2>&1; then
  if ! openssl x509 -in "$crt" -noout 2>/dev/null; then
    err "$crt không phải chứng chỉ PEM hợp lệ"
  else
    # Khoá có khớp chứng chỉ không (so khoá công khai)
    if [[ "$(openssl x509 -in "$crt" -noout -pubkey 2>/dev/null | openssl sha256)" != \
          "$(openssl pkey -in "$key" -pubout 2>/dev/null | openssl sha256)" ]]; then
      err "$key không khớp với $crt"
    fi
    if ! openssl x509 -in "$crt" -noout -checkend $((30 * 86400)) >/dev/null 2>&1; then
      warn "Chứng chỉ Origin CA hết hạn trong vòng 30 ngày — tạo chứng chỉ mới"
    fi
    if [[ -n "$domain" ]] && ! openssl x509 -in "$crt" -noout -ext subjectAltName 2>/dev/null \
         | grep -qE "DNS:(\*\.)?${domain//./\\.}"; then
      err "Chứng chỉ không chứa tên miền $domain"
    fi
    if ! openssl x509 -in "$crt" -noout -issuer 2>/dev/null | grep -qi cloudflare; then
      warn "Chứng chỉ không do Cloudflare cấp — Full (strict) chỉ chấp nhận Origin CA hoặc CA công khai"
    fi
  fi
  perm="$(stat -c '%a' "$key" 2>/dev/null || echo '')"
  [[ -n "$perm" && "${perm: -1}" != "0" ]] && warn "$key đang cho mọi người đọc — chạy: chmod 600 $key"
fi

if [[ "$(get CADDY_TLS)" == "origin_tls_aop" && ! -s "$CERT_DIR/cloudflare-origin-pull-ca.pem" ]]; then
  err "CADDY_TLS=origin_tls_aop nhưng thiếu $CERT_DIR/cloudflare-origin-pull-ca.pem"
fi

perm="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo '')"
[[ -n "$perm" && "${perm: -1}" != "0" ]] && warn "$ENV_FILE đang cho mọi người đọc — chạy: chmod 600 $ENV_FILE"

echo
if (( errors > 0 )); then
  echo "KHÔNG ĐẠT: $errors lỗi, $warns cảnh báo."
  exit 1
fi
echo "ĐẠT: 0 lỗi, $warns cảnh báo."
