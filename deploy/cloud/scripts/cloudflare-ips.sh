#!/usr/bin/env bash
# =============================================================================
#  Tường lửa UFW: chỉ Cloudflare được gọi cổng 443 của VPS
# -----------------------------------------------------------------------------
#  Vì sao: nếu ai biết IP thật của VPS, họ có thể gọi thẳng vào máy chủ, bỏ qua
#  Cloudflare (WAF, chống DDoS) và giả header CF-Connecting-IP để né giới hạn
#  số lần đăng nhập (lỗi H-05 trong báo cáo review). Chỉ mở 443 cho dải IP của
#  Cloudflare thì header đó mới đáng tin.
#
#  Chạy (root):  ./scripts/cloudflare-ips.sh
#  Biến:         SSH_PORT (mặc định 22), DRY_RUN=1 (chỉ in lệnh),
#                CF_IPS_V4_FILE / CF_IPS_V6_FILE (dùng tệp có sẵn thay vì tải)
#  vps-setup.sh cài script này chạy hằng tuần để cập nhật khi Cloudflare đổi dải IP.
#
#  Lưu ý: UFW chỉ lọc được cổng của tiến trình trên host. Caddy chạy
#  `network_mode: host` nên được lọc; KHÔNG publish cổng Docker ra 0.0.0.0
#  (Docker tự chèn luật iptables đi vòng qua UFW).
# =============================================================================
set -euo pipefail

SSH_PORT="${SSH_PORT:-22}"
DRY_RUN="${DRY_RUN:-0}"
TAG="cloudflare-https"

run() {
  if [[ "$DRY_RUN" == "1" ]]; then echo "+ $*"; else "$@"; fi
}

fetch() {
  local url="$1" file="${2:-}"
  if [[ -n "$file" ]]; then cat "$file"; else curl -fsSL --max-time 20 "$url"; fi
}

if [[ "$DRY_RUN" != "1" && $EUID -ne 0 ]]; then
  echo "Cần chạy bằng root (sudo)." >&2; exit 1
fi

v4="$(fetch https://www.cloudflare.com/ips-v4 "${CF_IPS_V4_FILE:-}" | tr -d '\r' | grep -E '^[0-9.]+/[0-9]+$' || true)"
v6="$(fetch https://www.cloudflare.com/ips-v6 "${CF_IPS_V6_FILE:-}" | tr -d '\r' | grep -E '^[0-9a-fA-F:]+/[0-9]+$' || true)"
n4=$(grep -c . <<<"$v4" || true); n6=$(grep -c . <<<"$v6" || true)

# Phòng tải lỗi: danh sách quá ngắn thì KHÔNG đụng vào luật đang chạy.
if (( n4 < 10 || n6 < 5 )); then
  echo "Danh sách IP Cloudflare bất thường (IPv4: $n4, IPv6: $n6) — giữ nguyên luật cũ." >&2
  exit 1
fi
echo "Dải IP Cloudflare: $n4 IPv4, $n6 IPv6"

run ufw default deny incoming
run ufw default allow outgoing
run ufw limit "${SSH_PORT}/tcp" comment ssh

# Xoá luật Cloudflare cũ (theo comment), từ số lớn xuống nhỏ để số thứ tự không lệch
if [[ "$DRY_RUN" != "1" ]]; then
  mapfile -t old < <(ufw status numbered | grep "# ${TAG}" | sed -E 's/^\[ *([0-9]+)\].*/\1/' | sort -rn)
  for n in "${old[@]}"; do ufw --force delete "$n" >/dev/null; done
  echo "Đã xoá ${#old[@]} luật cũ"
fi

while read -r cidr; do
  [[ -n "$cidr" ]] && run ufw allow proto tcp from "$cidr" to any port 443 comment "$TAG"
done <<<"$v4"$'\n'"$v6"

run ufw --force enable
[[ "$DRY_RUN" == "1" ]] || ufw status verbose | head -n 12
