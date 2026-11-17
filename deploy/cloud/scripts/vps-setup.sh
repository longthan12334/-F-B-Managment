#!/usr/bin/env bash
# =============================================================================
#  Chuẩn bị VPS mới (Ubuntu 22.04/24.04, Debian 12) — chạy MỘT lần bằng root
# -----------------------------------------------------------------------------
#  Dùng được cho VPS Việt Nam, DigitalOcean, Vultr… và Amazon EC2 (Ubuntu AMI).
#
#    sudo DEPLOY_PUBKEY="ssh-ed25519 AAAA... github-actions" ./vps-setup.sh
#
#  Biến:
#    DEPLOY_USER    tài khoản để GitHub Actions SSH vào (mặc định: deploy)
#    DEPLOY_PUBKEY  khoá công khai SSH cho tài khoản đó (khuyến nghị đặt)
#    APP_DIR        thư mục ứng dụng (mặc định: /opt/restomanager)
#    SSH_PORT       cổng SSH đang dùng (mặc định: 22) — script KHÔNG đổi cổng
#    SWAP_SIZE      dung lượng swap tạo thêm nếu chưa có (mặc định: 2G, "0" = bỏ)
#    HARDEN_SSH     1 = tắt đăng nhập bằng mật khẩu (chỉ bật khi đã có khoá SSH!)
#
#  Việc script làm: cập nhật gói, cài Docker + UFW + fail2ban + tự cập nhật bảo
#  mật, tạo tài khoản deploy, thư mục ứng dụng, swap, tường lửa chỉ nhận 443 từ
#  Cloudflare, xoay vòng log Docker.
# =============================================================================
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
DEPLOY_PUBKEY="${DEPLOY_PUBKEY:-}"
APP_DIR="${APP_DIR:-/opt/restomanager}"
SSH_PORT="${SSH_PORT:-22}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
HARDEN_SSH="${HARDEN_SSH:-0}"
HERE="$(cd "$(dirname "$0")" && pwd)"

step() { echo; echo "==> $*"; }
[[ $EUID -eq 0 ]] || { echo "Chạy bằng root: sudo $0" >&2; exit 1; }
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == "ubuntu" || "${ID:-}" == "debian" ]] || { echo "Chỉ hỗ trợ Ubuntu/Debian (đang là ${ID:-?})." >&2; exit 1; }

step "Cập nhật hệ thống và cài công cụ"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq ca-certificates curl gnupg ufw fail2ban unattended-upgrades openssl

step "Cài Docker Engine + Compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
else
  echo "Docker đã có: $(docker --version)"
fi
docker compose version

# Xoay vòng log cho mọi container (không ghi đè nếu đã có cấu hình riêng)
if [[ ! -f /etc/docker/daemon.json ]]; then
  cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
JSON
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null

step "Tạo tài khoản triển khai '$DEPLOY_USER'"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
# Thành viên nhóm docker có quyền tương đương root trên máy — chỉ cấp cho tài
# khoản dùng để triển khai, và chỉ đăng nhập bằng khoá SSH.
usermod -aG docker "$DEPLOY_USER"
if [[ -n "$DEPLOY_PUBKEY" ]]; then
  home_dir="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$home_dir/.ssh"
  touch "$home_dir/.ssh/authorized_keys"
  grep -qxF "$DEPLOY_PUBKEY" "$home_dir/.ssh/authorized_keys" || echo "$DEPLOY_PUBKEY" >> "$home_dir/.ssh/authorized_keys"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$home_dir/.ssh/authorized_keys"
  chmod 600 "$home_dir/.ssh/authorized_keys"
  echo "Đã thêm khoá SSH cho $DEPLOY_USER"
else
  echo "CHƯA đặt DEPLOY_PUBKEY — nhớ thêm khoá vào ~$DEPLOY_USER/.ssh/authorized_keys"
fi

step "Thư mục ứng dụng $APP_DIR"
install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR/certs"
# Container backup chạy bằng root nên ghi được; tài khoản deploy đọc/ghi bản pre-release.
install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR/backups"

step "Swap"
if [[ "$SWAP_SIZE" != "0" ]] && ! swapon --show | grep -q .; then
  fallocate -l "$SWAP_SIZE" /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "Đã tạo swap $SWAP_SIZE"
else
  echo "Bỏ qua (đã có swap hoặc SWAP_SIZE=0)"
fi

step "Tường lửa: SSH + 443 chỉ từ Cloudflare"
SSH_PORT="$SSH_PORT" "$HERE/cloudflare-ips.sh"
install -m 755 "$HERE/cloudflare-ips.sh" /usr/local/sbin/restomanager-cloudflare-ips
cat > /etc/cron.weekly/restomanager-cloudflare-ips <<CRON
#!/bin/sh
SSH_PORT=$SSH_PORT /usr/local/sbin/restomanager-cloudflare-ips >> /var/log/restomanager-cloudflare-ips.log 2>&1
CRON
chmod 755 /etc/cron.weekly/restomanager-cloudflare-ips

step "fail2ban cho SSH và tự cài bản vá bảo mật"
cat > /etc/fail2ban/jail.d/sshd.local <<JAIL
[sshd]
enabled = true
port = $SSH_PORT
maxretry = 5
bantime = 1h
JAIL
systemctl enable --now fail2ban >/dev/null
systemctl restart fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

if [[ "$HARDEN_SSH" == "1" ]]; then
  step "Tắt đăng nhập SSH bằng mật khẩu"
  if ! find /root/.ssh /home/*/.ssh -name authorized_keys -size +0 2>/dev/null | grep -q .; then
    echo "Không thấy authorized_keys nào có nội dung — KHÔNG tắt mật khẩu để tránh tự khoá mình." >&2
  else
    cat > /etc/ssh/sshd_config.d/90-restomanager.conf <<'SSHD'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
SSHD
    sshd -t && systemctl reload ssh 2>/dev/null || systemctl reload sshd
    echo "Đã tắt đăng nhập bằng mật khẩu."
  fi
fi

step "XONG"
cat <<NEXT
Việc tiếp theo (xem DEPLOY-CLOUDFLARE.md):
  1. Chép chứng chỉ Origin CA vào $APP_DIR/certs/origin.pem và origin.key (chmod 600)
  2. Tạo $APP_DIR/.env từ env.example (chmod 600) và chạy ./scripts/check-env.sh
  3. Đẩy mã lên nhánh main để GitHub Actions build và triển khai
Kiểm tra tường lửa:   ufw status numbered
NEXT
