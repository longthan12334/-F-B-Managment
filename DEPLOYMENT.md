# Triển khai RestoManager lên VPS với tên miền qua Cloudflare

> **Cách triển khai khuyến nghị đã chuyển sang [DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md)**:
> image build sẵn trên GitHub Container Registry, CI/CD bằng GitHub Actions,
> ảnh lưu trên Cloudflare R2, TLS bằng Cloudflare Origin CA, tường lửa chỉ nhận
> Cloudflare. Tài liệu dưới đây mô tả cách cũ (build trên VPS, MinIO, Let's
> Encrypt) và vẫn chạy được. Lưu ý: script sao lưu đã chuyển sang
> `deploy/cloud/scripts/backup.sh` và tạo tệp `.dump` (pg_dump -Fc) thay vì
> `.sql.gz` — xem mục Khôi phục.

Tài liệu này hướng dẫn đưa hệ thống lên một máy chủ VPS thật, có tên miền và
HTTPS, từ máy trắng đến lúc chạy được.

**Tổng thời gian:** khoảng 30–45 phút (trừ thời gian chờ DNS lan truyền).

---

## Mục lục

1. [Yêu cầu tối thiểu](#1-yêu-cầu-tối-thiểu)
2. [Chuẩn bị VPS](#2-chuẩn-bị-vps)
3. [Lấy mã nguồn và cấu hình](#3-lấy-mã-nguồn-và-cấu-hình)
4. [Cấu hình Cloudflare](#4-cấu-hình-cloudflare)
5. [Triển khai](#5-triển-khai)
6. [Kiểm chứng sau triển khai](#6-kiểm-chứng-sau-triển-khai)
7. [Sao lưu và khôi phục](#7-sao-lưu-và-khôi-phục)
8. [Chuyển kho ảnh sang Cloudflare R2](#8-chuyển-kho-ảnh-sang-cloudflare-r2)
9. [Vận hành thường ngày](#9-vận-hành-thường-ngày)
10. [Khắc phục sự cố](#10-khắc-phục-sự-cố)

---

## 1. Yêu cầu tối thiểu

| Thành phần | Tối thiểu | Khuyến nghị | Ghi chú |
|---|---|---|---|
| CPU | 1 nhân | 2 nhân | |
| RAM | 2 GB | 4 GB | Dưới 2 GB thì bước build Vite sẽ bị kill |
| Ổ cứng | 20 GB SSD | 40 GB SSD | Ảnh món ăn và sao lưu chiếm dần |
| Hệ điều hành | Ubuntu 22.04 / Debian 12 | Ubuntu 24.04 LTS | |
| Tên miền | 1 tên miền đã trỏ nameserver về Cloudflare | | |

**Ước lượng chi phí (2026):** VPS 2 nhân/4 GB khoảng 5–10 USD/tháng
(Hetzner, Vultr, DigitalOcean, hoặc VPS trong nước như Vietnix, AZDIGI).
Cloudflare gói miễn phí là đủ dùng.

> **Máy yếu (1–2 GB RAM)?** Build ảnh frontend trên máy cá nhân rồi đẩy lên
> registry, VPS chỉ `docker compose pull`. Xem [mục 10](#10-khắc-phục-sự-cố).

---

## 2. Chuẩn bị VPS

### 2.1. Tạo người dùng riêng (không dùng root)

```bash
ssh root@<IP_VPS>

adduser resto
usermod -aG sudo resto
rsync --archive --chown=resto:resto ~/.ssh /home/resto    # chép khoá SSH

# Từ giờ dùng tài khoản này
exit
ssh resto@<IP_VPS>
```

### 2.2. Cài Docker Engine + Compose v2

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER

# Thoát rồi vào lại để nhóm docker có hiệu lực
exit && ssh resto@<IP_VPS>

docker --version          # ≥ 24
docker compose version    # ≥ 2.24 (cần cho cú pháp !override)
```

### 2.3. Tường lửa — chỉ mở 3 cổng

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status numbered
```

> **Vì sao không mở 5432 (PostgreSQL) và 9000 (MinIO)?**
> `docker-compose.prod.yml` đã gỡ toàn bộ `ports` của hai dịch vụ này; chúng
> chỉ nghe trong mạng nội bộ Docker. Cần nối pgAdmin từ máy cá nhân thì dùng
> SSH tunnel — xem [mục 9](#9-vận-hành-thường-ngày).

### 2.4. Tăng cường SSH (khuyến nghị)

```bash
sudo nano /etc/ssh/sshd_config
# PermitRootLogin no
# PasswordAuthentication no
sudo systemctl restart ssh
```

### 2.5. Cập nhật bảo mật tự động

```bash
sudo apt update && sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

---

## 3. Lấy mã nguồn và cấu hình

```bash
cd ~
git clone <URL_REPO_CỦA_BẠN> restomanager
cd restomanager
cp .env.example .env
```

### 3.1. Sinh secret

```bash
# Chạy ba lần, mỗi lần một giá trị KHÁC NHAU
openssl rand -base64 48   # → JWT_SECRET
openssl rand -base64 48   # → REFRESH_SECRET
openssl rand -base64 48   # → GUEST_SECRET

# Mật khẩu CSDL và MinIO
openssl rand -base64 32   # → DB_PASSWORD
openssl rand -base64 32   # → MINIO_SECRET_KEY
```

### 3.2. Chỉnh `.env`

```bash
nano .env
```

Tối thiểu phải đổi:

```env
NODE_ENV=production
APP_VERSION=3.0.0

DOMAIN=nhahang.cua-ban.vn
ACME_EMAIL=ban@email.com

DB_PASSWORD=<giá trị vừa sinh>
JWT_SECRET=<giá trị 1>
REFRESH_SECRET=<giá trị 2>
GUEST_SECRET=<giá trị 3>

ALLOWED_ORIGINS=https://nhahang.cua-ban.vn

MINIO_ACCESS_KEY=resto-minio
MINIO_SECRET_KEY=<giá trị vừa sinh>
S3_PUBLIC_URL=https://cdn.nhahang.cua-ban.vn

# Lần đầu để true để có tài khoản admin; sau khi đổi mật khẩu thì đặt false
SEED_ON_BOOT=true
```

> `deploy/deploy.sh` kiểm tra lại toàn bộ các giá trị trên và **từ chối triển
> khai** nếu còn giá trị mẫu, secret ngắn hơn 32 ký tự, hoặc `JWT_SECRET`
> trùng `REFRESH_SECRET`. Bản thân backend cũng kiểm tra lần nữa khi khởi động
> (`src/shared/config.js`) — hai lớp để không ai vô tình đẩy cấu hình yếu lên
> production.

---

## 4. Cấu hình Cloudflare

Có hai cách. **Cách A** phù hợp với hầu hết trường hợp.

### 4A. Cách A — DNS proxy (khuyến nghị)

#### Bước 1: Trỏ nameserver về Cloudflare

1. Đăng nhập [dash.cloudflare.com](https://dash.cloudflare.com) → **Add a site**
2. Nhập tên miền, chọn gói **Free**
3. Cloudflare cấp 2 nameserver, ví dụ `ava.ns.cloudflare.com`
4. Vào trang quản lý tên miền (PA Vietnam, Mat Bao, Namecheap…) đổi nameserver
5. Chờ 5 phút đến vài giờ. Kiểm tra: `dig NS nhahang.cua-ban.vn +short`

#### Bước 2: Tạo bản ghi DNS

Vào **DNS → Records**, thêm ba bản ghi:

| Type | Name | Content | Proxy | TTL |
|---|---|---|---|---|
| A | `@` | `<IP_VPS>` | 🟠 Proxied | Auto |
| A | `cdn` | `<IP_VPS>` | 🟠 Proxied | Auto |
| A | `minio` | `<IP_VPS>` | ⚪ **DNS only** | Auto |

**Vì sao `minio` để DNS only?** Giao diện quản trị MinIO dùng WebSocket và tải
tệp lớn; qua proxy Cloudflare gói Free sẽ bị giới hạn 100 MB mỗi request. Để
DNS only nghĩa là truy cập thẳng VPS — nên hãy giới hạn theo IP trong
`deploy/Caddyfile`, hoặc xoá hẳn khối `minio.{$DOMAIN}` nếu không dùng.

#### Bước 3: Bật TLS đúng chế độ ⚠️

**SSL/TLS → Overview → chọn `Full (strict)`**

> Đây là lỗi cấu hình phổ biến nhất. Nếu để **Flexible**, Cloudflare gọi về
> máy chủ bằng HTTP trong khi Caddy chuyển hướng mọi HTTP sang HTTPS → trình
> duyệt báo **ERR_TOO_MANY_REDIRECTS**. Caddy đã có chứng chỉ Let's Encrypt
> hợp lệ nên `Full (strict)` chạy ngay.

#### Bước 4: Các thiết lập nên bật

| Mục | Thiết lập | Lý do |
|---|---|---|
| SSL/TLS → Edge Certificates | **Always Use HTTPS**: On | Chuyển hướng tại biên, nhanh hơn |
| SSL/TLS → Edge Certificates | **Minimum TLS Version**: 1.2 | Loại bỏ TLS cũ |
| Speed → Optimization | **Brotli**: On | Nén tốt hơn gzip |
| Caching → Configuration | **Browser Cache TTL**: Respect Existing Headers | Để Caddy/Nginx quyết định |
| Network | **WebSockets**: On | **Bắt buộc** — Socket.IO cần |
| Network | **HTTP/3 (QUIC)**: On | Nhanh hơn trên mạng di động kém |

#### Bước 5: Quy tắc cache cho API (quan trọng)

Mặc định Cloudflare không cache HTML/JSON, nhưng hãy khai báo tường minh để
chắc chắn không bao giờ cache API.

**Caching → Cache Rules → Create rule**

| Trường | Giá trị |
|---|---|
| Rule name | `Bypass cache for API` |
| When incoming requests match | `URI Path` `starts with` `/api/` |
| Then | **Bypass cache** |

Thêm quy tắc thứ hai cho WebSocket:

| Trường | Giá trị |
|---|---|
| Rule name | `Bypass cache for Socket.IO` |
| When | `URI Path` `starts with` `/socket.io/` |
| Then | **Bypass cache** |

Và một quy tắc cache mạnh cho ảnh món ăn:

| Trường | Giá trị |
|---|---|
| Rule name | `Cache menu images` |
| When | `Hostname` `equals` `cdn.nhahang.cua-ban.vn` |
| Then | **Eligible for cache**, Edge TTL: 1 month |

#### Bước 6: Chặn lạm dụng trang khách quét QR (tuỳ chọn)

Trang `/api/public/*` không cần đăng nhập nên dễ bị dò. Backend đã giới hạn
30 request/phút/IP, thêm một lớp ở biên Cloudflare thì càng tốt:

**Security → WAF → Rate limiting rules**

| Trường | Giá trị |
|---|---|
| Rule name | `Giới hạn API công khai` |
| When | `URI Path` `starts with` `/api/public/` |
| Requests | 60 trong 1 phút, theo IP |
| Then | Block trong 10 phút |

---

### 4B. Cách B — Cloudflare Tunnel (khi VPS không có IP công khai)

Dùng khi VPS nằm sau NAT, hoặc bạn muốn **không mở cổng 80/443 nào** ra
Internet. Tunnel tạo kết nối đi-ra tới Cloudflare, traffic đi vào qua đường
hầm đó.

1. **Zero Trust → Networks → Tunnels → Create a tunnel**
2. Chọn **Cloudflared**, đặt tên `restomanager`
3. Sao chép token (chuỗi dài bắt đầu bằng `eyJ...`)
4. Thêm vào `.env`:
   ```env
   CLOUDFLARE_TUNNEL_TOKEN=eyJ...
   ```
5. Trong tab **Public Hostnames** của tunnel, thêm:

   | Subdomain | Domain | Service |
   |---|---|---|
   | (để trống) | `nhahang.cua-ban.vn` | `HTTP` → `caddy:80` |
   | `cdn` | `nhahang.cua-ban.vn` | `HTTP` → `caddy:80` |

6. Chạy kèm profile `tunnel`:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml \
     --profile tunnel up -d
   ```
7. Giờ có thể đóng luôn cổng 80/443:
   ```bash
   sudo ufw delete allow 80/tcp
   sudo ufw delete allow 443/tcp
   ```

> Với cách B, Caddy không xin được chứng chỉ Let's Encrypt (không có cổng 80
> công khai) — nhưng không cần, vì Cloudflare đã cung cấp TLS ở biên và tunnel
> được mã hoá sẵn.

---

## 5. Triển khai

```bash
cd ~/restomanager
chmod +x deploy/deploy.sh deploy/cloud/scripts/*.sh
./deploy/deploy.sh
```

Kịch bản sẽ lần lượt:

1. Kiểm tra Docker, `.env`, độ mạnh của các secret
2. Sao lưu CSDL hiện có (lần đầu thì bỏ qua)
3. Chạy `check-boundaries` — **từ chối triển khai nếu mã nguồn vi phạm ranh
   giới module**
4. Build ảnh Docker
5. Khởi động và chờ backend báo sẵn sàng
6. Gọi thử `/api/health` và HTTPS công khai

Lần đầu mất khoảng 3–5 phút (build Vite và npm install). Caddy cần thêm
1–2 phút để xin chứng chỉ Let's Encrypt.

---

## 6. Kiểm chứng sau triển khai

```bash
# 1. Tất cả container đang chạy và khoẻ
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps

# 2. Sức khoẻ hệ thống
curl -s https://nhahang.cua-ban.vn/api/health | jq .data.status
# → "ok"

# 3. Tám module đã nạp
curl -s https://nhahang.cua-ban.vn/api/architecture | jq '.data.count, .data.loadOrder'
# → 8
# → ["identity","dining","catalog","ordering","billing","analytics","auditing","guest-access"]

# 4. Chứng chỉ TLS hợp lệ
curl -sI https://nhahang.cua-ban.vn | head -1
echo | openssl s_client -connect nhahang.cua-ban.vn:443 2>/dev/null \
  | openssl x509 -noout -issuer -dates

# 5. Cloudflare đang proxy (có header cf-ray)
curl -sI https://nhahang.cua-ban.vn | grep -i 'cf-ray\|server'

# 6. API không bị cache
curl -sI https://nhahang.cua-ban.vn/api/health | grep -i 'cf-cache-status'
# → BYPASS hoặc DYNAMIC

# 7. CSDL không lộ ra Internet
nmap -p 5432,9000 nhahang.cua-ban.vn
# → filtered / closed (KHÔNG được là open)
```

### Kiểm thử nghiệp vụ

```bash
# Chạy bộ kiểm thử đầu-cuối ngay trên máy chủ
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  exec backend node tests/e2e-smoke.js
```

### Kiểm thử thủ công

1. Mở `https://nhahang.cua-ban.vn` → đăng nhập `admin` / `123`
2. **Đổi mật khẩu ngay** (Cá nhân → Đổi mật khẩu), rồi đổi cả `cashier`,
   `waiter`
3. Đặt `SEED_ON_BOOT=false` trong `.env` và chạy lại `./deploy/deploy.sh`
4. **Bàn → nút QR** → in mã QR của một bàn
5. Dùng điện thoại (tắt Wi-Fi, dùng 4G) quét mã → phải mở được trang gọi món
6. Gọi vài món → mở tab thu ngân → **Khách gọi** phải thấy yêu cầu **ngay lập
   tức** (nếu không thấy mà phải F5 thì WebSocket chưa thông — xem mục 10)
7. Bấm Xác nhận → màn hình điện thoại khách phải đổi trạng thái không cần F5

---

## 7. Sao lưu và khôi phục

### Tự động

Dịch vụ `backup` dump PostgreSQL mỗi ngày lúc 03:00 giờ Việt Nam vào
`./backups/`, giữ 14 ngày.

```bash
ls -lh backups/
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs backup
```

### ⚠ Đưa bản sao lưu ra khỏi VPS

Bản sao lưu đang nằm **cùng ổ đĩa** với CSDL. Ổ hỏng là mất cả hai. Chọn một
trong các cách sau:

```bash
# Cách 1 — rsync về máy ở nhà (chạy trên máy nhà, thêm vào crontab)
rsync -avz resto@<IP_VPS>:~/restomanager/backups/ ~/backup-nhahang/

# Cách 2 — đẩy lên Cloudflare R2 (dùng rclone)
rclone sync ~/restomanager/backups/ r2:nhahang-backup/
```

### Khôi phục

```bash
cd ~/restomanager
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

$COMPOSE stop backend                       # ngừng ghi mới
# Bản .dump do deploy/cloud/scripts/backup.sh tạo (pg_dump -Fc):
$COMPOSE exec -T postgres pg_restore --clean --if-exists --no-owner \
  -U postgres -d restaurant_db < backups/restaurant_db-20260301-030000.dump
$COMPOSE start backend
```

### Sao lưu ảnh trên MinIO

```bash
docker run --rm -v restomanager_minio_data:/data -v $PWD/backups:/backup \
  alpine tar czf /backup/minio-$(date +%F).tar.gz -C /data .
```

---

## 8. Chuyển kho ảnh sang Cloudflare R2

MinIO tự host là đủ cho một nhà hàng. Nhưng nếu muốn ảnh được phục vụ từ mạng
biên toàn cầu và không tốn băng thông VPS, Cloudflare R2 là lựa chọn tốt —
**miễn phí hoàn toàn băng thông đi ra**.

Nhờ lớp trừu tượng `StoragePort` (xem báo cáo mục 5.6), việc chuyển đổi
**không cần sửa một dòng mã nghiệp vụ nào**.

### Bước 1: Tạo bucket R2

1. Cloudflare dashboard → **R2** → **Create bucket** → đặt tên `restaurant`
2. **Manage R2 API Tokens** → **Create API Token**
   - Permissions: **Object Read & Write**
   - Specify bucket: `restaurant`
3. Ghi lại: **Access Key ID**, **Secret Access Key**, **Account ID**

### Bước 2: Gắn tên miền tuỳ chỉnh cho bucket

Trong bucket → **Settings → Public access → Custom Domains** → thêm
`cdn.nhahang.cua-ban.vn`. Cloudflare tự tạo bản ghi DNS và cấp chứng chỉ.

### Bước 3: Chép dữ liệu cũ sang (nếu đã có ảnh trên MinIO)

```bash
# Cài rclone trên VPS
curl https://rclone.org/install.sh | sudo bash

rclone config   # tạo 2 remote: 'minio' (S3, endpoint http://localhost:9000)
                #               'r2'    (S3, endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com)

rclone sync minio:restaurant r2:restaurant --progress
```

### Bước 4: Đổi cấu hình

```env
STORAGE_DRIVER=r2
S3_ENDPOINT=<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_PORT=443
S3_USE_SSL=true
S3_REGION=auto
S3_ACCESS_KEY=<R2 Access Key ID>
S3_SECRET_KEY=<R2 Secret Access Key>
S3_BUCKET=restaurant
S3_PUBLIC_URL=https://cdn.nhahang.cua-ban.vn
S3_FORCE_PATH_STYLE=true
S3_SIGNED_URLS=false
```

### Bước 5: Áp dụng và kiểm chứng

```bash
./deploy/deploy.sh

# Xác nhận driver đã đổi
curl -s https://nhahang.cua-ban.vn/api/health | jq '.data.checks.storage'
# → { "ok": true, "driver": "r2", "bucket": "restaurant", ... }
```

Sau khi chắc chắn, có thể gỡ dịch vụ MinIO khỏi `docker-compose.yml` để
tiết kiệm khoảng 700 MB RAM.

> **URL ảnh cũ trong CSDL có hỏng không?** Không, nếu `S3_PUBLIC_URL` giữ
> nguyên `https://cdn.nhahang.cua-ban.vn`. Cột `menu_items.image_url` lưu URL
> đầy đủ theo tên miền này; chỉ có bản ghi DNS phía sau là đổi.

---

## 9. Vận hành thường ngày

```bash
cd ~/restomanager
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

$COMPOSE ps                      # trạng thái
$COMPOSE logs -f backend         # theo dõi log backend
$COMPOSE logs --tail=100 caddy   # log reverse proxy
$COMPOSE restart backend         # khởi động lại một dịch vụ
$COMPOSE down                    # dừng (giữ nguyên dữ liệu)
$COMPOSE down -v                 # ⚠ dừng + XOÁ TOÀN BỘ dữ liệu

./deploy/deploy.sh               # cập nhật phiên bản mới
```

### Vào CSDL

```bash
$COMPOSE exec postgres psql -U postgres restaurant_db
```

### Mở pgAdmin từ máy cá nhân (SSH tunnel, không mở cổng)

```bash
# Chạy trên MÁY CÁ NHÂN
ssh -L 5432:localhost:5432 resto@<IP_VPS> \
  -o ProxyCommand='none' -N &

# Trên VPS, tạm phơi cổng vào localhost
$COMPOSE exec postgres true   # đảm bảo đang chạy
docker run --rm -d --name pgfwd --network restomanager_net -p 127.0.0.1:5432:5432 \
  alpine/socat tcp-listen:5432,fork,reuseaddr tcp-connect:postgres:5432

# Giờ pgAdmin trên máy cá nhân nối tới localhost:5432
# Xong thì: docker rm -f pgfwd
```

### Xem bản đồ kiến trúc đang chạy

```bash
curl -s https://nhahang.cua-ban.vn/api/architecture | jq
```

### Giám sát dung lượng

```bash
df -h                     # ổ đĩa
docker system df          # dung lượng Docker
docker system prune -a    # dọn ảnh không dùng (cẩn thận)
du -sh backups/           # kích thước sao lưu
```

---

## 10. Khắc phục sự cố

### `ERR_TOO_MANY_REDIRECTS`

**Nguyên nhân:** Cloudflare SSL/TLS đang ở chế độ **Flexible**.
**Xử lý:** SSL/TLS → Overview → đổi thành **Full (strict)**. Chờ 1 phút.

### Chứng chỉ không cấp được, Caddy báo lỗi ACME

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs caddy | grep -i acme
```

Nguyên nhân thường gặp:
- Bản ghi DNS chưa trỏ đúng IP VPS → `dig A nhahang.cua-ban.vn +short`
- Cổng 80 chưa mở → `sudo ufw status`
- Dùng Cloudflare proxy (🟠) ngay từ đầu nên Let's Encrypt không tới được máy
  chủ → **tạm chuyển sang ⚪ DNS only**, chờ cấp chứng chỉ xong rồi bật lại 🟠

### Thu ngân không thấy đơn mới ngay (phải F5)

WebSocket chưa thông. Kiểm tra theo thứ tự:

```bash
# 1. Cloudflare đã bật WebSockets chưa? (Network → WebSockets: On)

# 2. Thử handshake Socket.IO
curl -s "https://nhahang.cua-ban.vn/socket.io/?EIO=4&transport=polling" | head -c 120
# → phải trả JSON bắt đầu bằng 0{"sid":...

# 3. Xem log Caddy có chuyển tiếp /socket.io/ không
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs caddy | grep socket.io
```

### Backend khởi động rồi tắt ngay

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs backend | tail -40
```

Các lỗi `[config][FATAL]` là do cấu hình — backend cố tình từ chối chạy:

| Thông báo | Xử lý |
|---|---|
| `JWT_SECRET chưa được đặt` | Thêm vào `.env` |
| `JWT_SECRET chỉ dài N ký tự` | Sinh lại bằng `openssl rand -base64 48` |
| `JWT_SECRET đang dùng giá trị mẫu/yếu` | Đổi giá trị khác |
| `ALLOWED_ORIGINS bắt buộc ở production` | Đặt `https://<domain>` |
| `JWT_SECRET và REFRESH_SECRET phải khác nhau` | Sinh hai giá trị riêng |

### Build frontend bị kill (VPS 1–2 GB RAM)

Tạo swap tạm:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Hoặc build trên máy cá nhân rồi đẩy lên registry:

```bash
# Máy cá nhân
docker build -t ghcr.io/<user>/resto-frontend:3.0.0 ./front-end
docker push ghcr.io/<user>/resto-frontend:3.0.0

# VPS: sửa docker-compose.yml, thay `build:` bằng `image:` rồi
docker compose pull && docker compose up -d
```

### Ảnh món ăn không hiển thị

```bash
# 1. Kho đối tượng có khoẻ không?
curl -s https://nhahang.cua-ban.vn/api/health | jq '.data.checks.storage'

# 2. S3_PUBLIC_URL có đúng không?
grep S3_PUBLIC_URL .env
# Phải là https://cdn.<domain>, KHÔNG phải http://localhost:9000

# 3. Subdomain cdn đã có bản ghi DNS chưa?
dig A cdn.nhahang.cua-ban.vn +short

# 4. Tải thử một ảnh
curl -sI https://cdn.nhahang.cua-ban.vn/restaurant/menu/<tên-tệp>.jpg | head -3
```

### Khách quét QR báo "Không tìm thấy bàn"

Mã QR in từ phiên bản cũ dùng mã bàn (`/order/T1-01`), phiên bản 3 dùng
`qr_slug`. Hệ thống **vẫn chấp nhận cả hai** nên mã cũ không hỏng. Nếu vẫn
lỗi, kiểm tra bàn còn tồn tại và đang hoạt động:

```bash
$COMPOSE exec postgres psql -U postgres restaurant_db \
  -c "SELECT code, qr_slug, is_active FROM tables ORDER BY code;"
```

### Khôi phục nhanh khi triển khai hỏng

```bash
git log --oneline -5
git checkout <commit_trước_đó>
./deploy/deploy.sh

# Nếu CSDL cũng hỏng, khôi phục từ bản sao lưu trước khi triển khai
gunzip -c backups/pre-deploy-<timestamp>.sql.gz | \
  $COMPOSE exec -T postgres psql -U postgres restaurant_db
```

---

## Phụ lục — Danh mục kiểm tra trước khi bàn giao

- [ ] Đã đổi mật khẩu cả ba tài khoản mẫu
- [ ] `SEED_ON_BOOT=false` trong `.env`
- [ ] Ba secret đều ngẫu nhiên, khác nhau, ≥ 32 ký tự
- [ ] `ALLOWED_ORIGINS` đúng tên miền thật
- [ ] Cloudflare SSL/TLS = **Full (strict)**
- [ ] Cloudflare WebSockets = **On**
- [ ] Cache Rule bypass `/api/` và `/socket.io/`
- [ ] `nmap` xác nhận cổng 5432 và 9000 **không** mở
- [ ] Sao lưu tự động chạy được (`ls backups/`)
- [ ] Sao lưu đã được đồng bộ ra khỏi VPS
- [ ] Quét thử mã QR bằng 4G (không dùng Wi-Fi quán)
- [ ] Mở hai thiết bị kiểm tra đồng bộ thời gian thực
- [ ] `node tests/e2e-smoke.js` chạy đạt trên máy chủ
