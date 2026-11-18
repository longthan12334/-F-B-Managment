# Triển khai RestoManager: id.vn + Cloudflare + R2 + GHCR + GitHub Actions

Hướng dẫn đưa RestoManager lên Internet theo kiến trúc dưới đây, từ lúc chưa có
tên miền tới lúc mỗi lần `git push` lên nhánh `main` là hệ thống tự kiểm thử,
build và cập nhật trên máy chủ.

```
                    HTTPS (chứng chỉ công khai của Cloudflare)
  Trình duyệt ───────────────────────────────────────────► Cloudflare Edge
  (nhân viên, khách                                          │  DNS, WAF, chống DDoS,
   quét QR)                                                  │  cache, "Always Use HTTPS"
                                                             │
          ┌──────────────────────────────────────────────────┤
          │ https://img.<tên-miền>                           │ HTTPS (Origin CA, Full strict)
          ▼                                                  ▼
  ┌───────────────────┐                     ┌──────────────── VPS / EC2 ────────────────┐
  │  Cloudflare R2    │  ◄── backend ghi ── │ UFW: chỉ nhận 443 từ dải IP Cloudflare     │
  │  bucket ảnh món   │      ảnh qua API S3 │ Caddy :443 ─► 127.0.0.1:3000 backend      │
  └───────────────────┘                     │           └─► 127.0.0.1:8080 frontend      │
  ┌───────────────────┐                     │ PostgreSQL (không mở ra ngoài)            │
  │  R2 bucket backup │  ◄── rclone ─────── │ backup (03:00 hằng ngày) → ./backups      │
  └───────────────────┘                     └───────────────▲───────────────────────────┘
                                                            │ SSH: chép cấu hình,
  GitHub ── push main ──► Actions: test → build image ──────┘ pull image, release.sh
                                    └─► ghcr.io (GitHub Container Registry)
```

Toàn bộ cấu hình nằm trong thư mục [`deploy/cloud/`](deploy/cloud/); thư mục này
được chép nguyên lên VPS tại `/opt/restomanager`.

| Tệp | Vai trò |
|---|---|
| `deploy/cloud/compose.yml` | Các dịch vụ chạy trên VPS: postgres, backend, frontend, caddy, backup, backup-offsite |
| `deploy/cloud/Caddyfile` | Reverse proxy, TLS bằng chứng chỉ Origin CA, ẩn endpoint nội bộ |
| `deploy/cloud/env.example` | Mẫu `.env` cho production |
| `deploy/cloud/scripts/vps-setup.sh` | Chuẩn bị VPS mới: Docker, tài khoản `deploy`, tường lửa, swap, fail2ban |
| `deploy/cloud/scripts/cloudflare-ips.sh` | Tường lửa UFW chỉ mở 443 cho dải IP Cloudflare (tự chạy hằng tuần) |
| `deploy/cloud/scripts/check-env.sh` | Kiểm tra `.env` + chứng chỉ trước khi chạy |
| `deploy/cloud/scripts/release.sh` | Triển khai một tag: sao lưu → pull → up → kiểm tra → tự rollback |
| `deploy/cloud/scripts/backup.sh` | Sao lưu PostgreSQL hằng ngày (chạy trong container) |
| `deploy/cloud/scripts/dc.sh` | `docker compose` đã nạp sẵn tag đang chạy |
| `.github/workflows/ci.yml` | Kiểm thử mỗi Pull Request |
| `.github/workflows/deploy.yml` | Build image, đẩy GHCR, triển khai khi push `main` |

> **Trước khi thu tiền thật.** Bộ triển khai này đưa hệ thống lên mạng an toàn
> hơn, nhưng **không sửa lỗi nghiệp vụ** trong báo cáo review: màn hình thu
> ngân tính sai tiền khi có món bị từ chối (C-01), web đọc sai dữ liệu API v3
> (C-02), hoá đơn thiếu món khi thao tác đồng thời (H-01)… Hãy dùng bản triển
> khai này làm môi trường chạy thử cho tới khi các lỗi đó được sửa.

---

## Mục lục

0. [Chi phí và chuẩn bị](#0-chi-phí-và-chuẩn-bị)
1. [Tên miền id.vn](#1-tên-miền-idvn)
2. [Chuyển DNS sang Cloudflare](#2-chuyển-dns-sang-cloudflare)
3. [Cấu hình Cloudflare](#3-cấu-hình-cloudflare)
4. [Kho ảnh Cloudflare R2](#4-kho-ảnh-cloudflare-r2)
5. [SSL/TLS: Cloudflare Edge và Origin CA](#5-ssltls-cloudflare-edge-và-origin-ca)
6. [Docker registry: chọn GHCR](#6-docker-registry-chọn-ghcr)
7. [VPS hoặc Amazon EC2](#7-vps-hoặc-amazon-ec2)
8. [CI/CD với GitHub Actions](#8-cicd-với-github-actions)
9. [Lần triển khai đầu tiên](#9-lần-triển-khai-đầu-tiên)
10. [Vận hành hằng ngày](#10-vận-hành-hằng-ngày)
11. [Xử lý sự cố](#11-xử-lý-sự-cố)
12. [Những gì đã và chưa được kiểm chứng](#12-những-gì-đã-và-chưa-được-kiểm-chứng)

Trong tài liệu, `nhahang.id.vn` là tên miền ví dụ — thay bằng tên miền của bạn.

---

## 0. Chi phí và chuẩn bị

| Hạng mục | Lựa chọn | Chi phí |
|---|---|---|
| Tên miền | `.id.vn` | Miễn phí 2 năm (có điều kiện, xem mục 1) |
| DNS, HTTPS phía trình duyệt, chống DDoS | Cloudflare Free | 0đ |
| Kho ảnh | Cloudflare R2 | Miễn phí 10 GB-tháng lưu trữ, 1 triệu thao tác ghi (Class A), 10 triệu thao tác đọc (Class B) mỗi tháng; **không tính phí băng thông ra** |
| Registry image | GitHub Container Registry | Hiện miễn phí lưu trữ và băng thông |
| CI/CD | GitHub Actions | Miễn phí với repo công khai; repo riêng tư có hạn mức phút/tháng |
| Máy chủ | VPS 1–2 vCPU, 2 GB RAM, 20 GB SSD | Khoảng 100.000–250.000đ/tháng tại nhà cung cấp Việt Nam; hoặc EC2 dùng credit miễn phí (mục 7) |

Cần có: tài khoản GitHub (mã nguồn đã đẩy lên một repo), tài khoản Cloudflare,
một VPS chạy Ubuntu 22.04/24.04 (hoặc Debian 12), và máy tính có `ssh`, `git`.

Thời gian: khoảng 1,5–2 giờ cho lần đầu, phần lớn là chờ DNS và đăng ký tên miền.

---

## 1. Tên miền id.vn

`.id.vn` là tên miền cấp 3 dưới `.vn`, dành cho cá nhân. Chương trình hỗ trợ
của VNNIC cho công dân Việt Nam **từ đủ 18 đến 23 tuổi** được dùng miễn phí 2 năm.
Theo [bài viết của Quasa](https://quasa.io/vi/media/ten-mien-idvn-mien-phi-2-nam-chon-sai-ho-so-ekyc-rat-kho-sua)
(nguồn thứ ba — hãy đối chiếu với nhà đăng ký trước khi làm):

- Định danh bằng eKYC với CCCD gắn chip; ngày sinh lấy từ CCCD nên ngoài độ tuổi là không qua được.
- Mỗi số CCCD nhận **một** tên miền miễn phí.
- Tên miền đứng tên người trong hồ sơ eKYC đã chọn — kiểm tra kỹ trước khi bấm xác nhận, sửa sau rất khó.
- Hết 2 năm phải gia hạn (bài viết dẫn phí duy trì của VNNIC 50.000đ/năm; giá gia hạn thực tế do nhà đăng ký quyết định). Ghi lại ngày hết hạn: tên miền hết hạn là website ngừng chạy.

**Các bước:**
1. Vào trang đăng ký tên miền miễn phí của một nhà đăng ký tên miền .vn được VNNIC công nhận, tìm tên còn trống.
2. Làm eKYC bằng CCCD và khuôn mặt, chọn đúng hồ sơ của chính bạn.
3. Xác nhận đăng ký. Không cần mua hosting hay email kèm theo — ta dùng VPS riêng.
4. Đăng nhập trang quản trị tên miền của nhà đăng ký, tìm mục **"Cập nhật DNS"** /
   **"Đổi nameserver"** — sẽ dùng ở bước 2.

> `id.vn` có trong [Public Suffix List](https://github.com/publicsuffix/list)
> (danh sách các "đuôi" tên miền), nên Cloudflare coi `nhahang.id.vn` là một tên
> miền gốc và cho thêm vào như một website bình thường.

---

## 2. Chuyển DNS sang Cloudflare

DNS là "danh bạ" đổi tên miền thành địa chỉ IP. Chuyển DNS sang Cloudflare
nghĩa là Cloudflare trả lời câu hỏi "nhahang.id.vn ở đâu?" — nhờ đó Cloudflare
đứng chắn trước máy chủ của bạn.

1. Đăng nhập Cloudflare → **Add a domain** → nhập `nhahang.id.vn` → chọn gói **Free**.
2. Cloudflare quét các bản ghi DNS cũ. Xoá các bản ghi trỏ về hosting mặc định
   của nhà đăng ký nếu bạn không dùng.
3. Cloudflare hiển thị **2 nameserver** (dạng `xxx.ns.cloudflare.com`).
4. Ở trang quản trị của nhà đăng ký (mục 1, bước 4): thay toàn bộ nameserver
   hiện tại bằng 2 nameserver của Cloudflare, lưu lại.
5. Chờ Cloudflare báo **Active** (thường vài phút tới vài giờ, tối đa 24–48 giờ).
   Kiểm tra từ máy bạn:
   ```bash
   dig NS nhahang.id.vn +short      # phải ra 2 nameserver của Cloudflare
   ```

**Bản ghi DNS cần tạo** (DNS → Records) — làm sau khi có IP của VPS ở mục 7:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `@` | IP công khai của VPS | **Proxied** (đám mây cam) |
| CNAME | `www` | `nhahang.id.vn` | **Proxied** |
| *(tự tạo)* | `img` | do R2 tạo khi gắn custom domain (mục 4) | Proxied |

Đám mây cam (**Proxied**) là bắt buộc: không có nó, trình duyệt gọi thẳng VPS,
gặp chứng chỉ Origin CA (trình duyệt không tin) và bị tường lửa chặn.

> Không tạo bản ghi kiểu `ssh.nhahang.id.vn` trỏ về VPS với đám mây cam:
> Cloudflare không chuyển tiếp SSH. SSH bằng **IP** của VPS.

---

## 3. Cấu hình Cloudflare

Trong dashboard của tên miền:

| Mục | Thiết lập | Lý do |
|---|---|---|
| SSL/TLS → Overview | **Full (strict)** | Cloudflare gọi về VPS bằng HTTPS và kiểm tra chứng chỉ. "Flexible" sẽ hỏng vì Caddy không mở cổng 80 |
| SSL/TLS → Edge Certificates | **Always Use HTTPS**: On | Chuyển http → https ngay tại Cloudflare |
| SSL/TLS → Edge Certificates | **Minimum TLS Version**: TLS 1.2 | Bỏ giao thức cũ |
| Network | **WebSockets**: On (mặc định) | Socket.IO cập nhật màn hình thời gian thực |
| Security → WAF → Rate limiting rules *(tuỳ chọn)* | 1 luật: đường dẫn `/api/auth/login`, ví dụ 20 yêu cầu/10 giây/IP → Block | Lớp chặn dò mật khẩu thứ hai, trước cả backend |

Không cần Page Rule cache: Cloudflare mặc định không cache đường dẫn API (không
có phần mở rộng tĩnh), còn tệp `/assets/*` của Vite đã có header cache dài hạn.

---

## 4. Kho ảnh Cloudflare R2

R2 là kho đối tượng tương thích S3 của Cloudflare. Ảnh món ăn lưu ở đây và
trình duyệt tải thẳng từ `https://img.nhahang.id.vn`, không đi qua VPS.

### 4.1 Bucket ảnh (công khai qua tên miền riêng)

1. Dashboard tài khoản → **R2 Object Storage** → kích hoạt R2 (có thể phải nhập
   phương thức thanh toán dù dùng trong hạn mức miễn phí).
2. **Create bucket**: tên ví dụ `nhahang-images`, Location: *Automatic* (hoặc gợi ý Asia-Pacific).
3. Mở bucket → **Settings** → **Custom Domains** → **Connect Domain** →
   `img.nhahang.id.vn`. Cloudflare tự tạo bản ghi DNS và chứng chỉ.
4. **Không** bật *r2.dev subdomain* cho production (địa chỉ này bị giới hạn tốc độ,
   chỉ dành cho thử nghiệm).

### 4.2 Token API cho backend

R2 → **Manage R2 API Tokens** → **Create API token**:
- Permissions: **Object Read & Write**
- Specify bucket(s): chỉ `nhahang-images`
- Tạo xong, chép ngay **Access Key ID**, **Secret Access Key** (chỉ hiện một lần)
  và **endpoint** `https://<account-id>.r2.cloudflarestorage.com`.

Điền vào `.env` (mục 9):
```ini
STORAGE_DRIVER=r2
S3_ENDPOINT=<account-id>.r2.cloudflarestorage.com   # KHÔNG kèm https://
S3_PORT=443
S3_USE_SSL=true
S3_REGION=auto
S3_BUCKET=nhahang-images
S3_ACCESS_KEY=<Access Key ID>
S3_SECRET_KEY=<Secret Access Key>
S3_PUBLIC_URL=https://img.nhahang.id.vn
```

Với `STORAGE_DRIVER=r2`, backend (đã sửa trong đợt này):
- **không** tự tạo bucket và không đặt bucket policy — token chỉ có quyền trên
  đối tượng, và R2 không hỗ trợ bucket policy;
- sinh URL ảnh dạng `https://img.nhahang.id.vn/menu/<tệp>` (không chèn tên bucket,
  vì tên miền đã gắn thẳng vào bucket);
- kiểm tra kết nối bằng cách liệt kê 1 đối tượng, nên `/api/health` báo đúng
  khi sai bucket, sai khoá hay mất mạng.

### 4.3 Bucket sao lưu (riêng tư) — khuyến nghị

1. Tạo bucket thứ hai, ví dụ `nhahang-backups`. **Không** gắn custom domain,
   **không** bật r2.dev — bucket này phải riêng tư.
2. Bucket → Settings → **Object lifecycle rules** → xoá đối tượng sau 30 ngày.
3. Tạo **token riêng** (Object Read & Write, chỉ bucket `nhahang-backups`) và điền
   các biến `BACKUP_R2_*` trong `.env`. Dùng token khác với token ảnh: lộ một
   token không kéo theo cái còn lại.

### 4.4 Nếu đã có ảnh trên MinIO cũ

Chép dữ liệu bằng `rclone` (xem [DEPLOYMENT.md mục 8](DEPLOYMENT.md#8-chuyển-kho-ảnh-sang-cloudflare-r2)),
rồi cập nhật URL đã lưu trong CSDL sang dạng mới:
```sql
UPDATE menu_items
   SET image_url = 'https://img.nhahang.id.vn/' || image_key
 WHERE image_key IS NOT NULL;
```

---

## 5. SSL/TLS: Cloudflare Edge và Origin CA

Có **hai chặng** mã hoá:

| Chặng | Chứng chỉ | Ai tin |
|---|---|---|
| Trình duyệt → Cloudflare Edge | Cloudflare tự cấp và gia hạn | Mọi trình duyệt |
| Cloudflare Edge → VPS | **Cloudflare Origin CA**, bạn tạo một lần, sống tới 15 năm | Chỉ Cloudflare |

Vì chặng 2 dùng Origin CA nên Caddy trên VPS không cần xin Let's Encrypt, không
cần mở cổng 80 và không lo hết hạn mỗi 90 ngày.

### 5.1 Tạo chứng chỉ Origin CA

1. SSL/TLS → **Origin Server** → **Create Certificate**.
2. *Generate private key and CSR with Cloudflare*, Key type: RSA (2048) hoặc ECC.
3. Hostnames: `nhahang.id.vn`, `*.nhahang.id.vn` (mặc định đã có sẵn).
   Ký tự đại diện chỉ phủ **một** cấp: `*.nhahang.id.vn` không phủ `a.b.nhahang.id.vn`.
4. Validity: 15 years → **Create**. Định dạng: **PEM**.
5. Lưu **Origin Certificate** thành `origin.pem`, **Private Key** thành `origin.key`.
   Khoá riêng **chỉ hiện một lần**.

Đưa lên VPS (sau mục 7):
```bash
scp origin.pem origin.key deploy@<IP_VPS>:/opt/restomanager/certs/
ssh deploy@<IP_VPS> 'chmod 600 /opt/restomanager/certs/origin.key'
```

### 5.2 Authenticated Origin Pulls (tuỳ chọn, khuyến nghị)

Tường lửa đã chỉ cho IP Cloudflare vào cổng 443. Authenticated Origin Pulls
thêm một lớp: Caddy đòi Cloudflare trình **chứng chỉ client**; ai gọi thẳng VPS
không có chứng chỉ đó bị từ chối ngay khi bắt tay TLS.

Làm **đúng thứ tự** để không gián đoạn:
1. Tải CA của Cloudflare về VPS:
   ```bash
   curl -fsSL https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem \
     -o /opt/restomanager/certs/cloudflare-origin-pull-ca.pem
   ```
2. Dashboard → SSL/TLS → **Origin Server** → **Authenticated Origin Pulls** → bật
   (Cloudflare bắt đầu gửi chứng chỉ; Caddy chưa đòi nên vẫn chạy bình thường).
3. Trong `.env` đặt `CADDY_TLS=origin_tls_aop`, rồi `./scripts/dc.sh up -d caddy`.

Chứng chỉ client dùng chung cho mọi khách hàng Cloudflare — nó chứng minh yêu
cầu đến từ mạng Cloudflare, không chứng minh đến từ *tài khoản của bạn*.

---

## 6. Docker registry: chọn GHCR

Registry là nơi lưu image Docker đã build, để VPS chỉ cần **kéo về** thay vì tự build.

| Lựa chọn | Ưu | Nhược | Kết luận |
|---|---|---|---|
| Registry tự cài trên VPS | Toàn quyền | Tốn RAM, đĩa; phải tự lo TLS, mật khẩu, sao lưu; VPS hỏng là mất cả registry | Không nên ở quy mô này |
| Docker Hub | Phổ biến | Gói miễn phí giới hạn repo riêng tư (theo ghi chú của bạn là 1 repo — đối chiếu [trang giá Docker](https://www.docker.com/pricing/faq)); giới hạn lượt pull: 100 lượt/6 giờ khi chưa đăng nhập, 200 lượt/6 giờ với tài khoản Personal ([docs](https://docs.docker.com/docker-hub/usage/pulls/)) | Được, nhưng dự án cần 2 image |
| **GitHub Container Registry (ghcr.io)** | Cùng chỗ với mã nguồn và Actions; đăng nhập bằng token tạm của mỗi lần chạy; nhiều image riêng tư | Phụ thuộc GitHub | **Chọn** |

Theo [tài liệu GitHub](https://docs.github.com/en/billing/concepts/product-billing/github-packages):
lưu trữ và băng thông của Container registry **hiện đang miễn phí** (GitHub cam
kết báo trước ít nhất một tháng nếu thay đổi). Kéo image bằng `GITHUB_TOKEN`
trong Actions luôn miễn phí.

Workflow tạo 2 package, mặc định **riêng tư**:
- `ghcr.io/<tên-github>/restomanager-backend`
- `ghcr.io/<tên-github>/restomanager-frontend`

Mỗi lần build có 2 tag: `sha-<7 ký tự commit>` (bất biến, dùng để triển khai và
rollback) và `latest` (chỉ để tham khảo). VPS không lưu mật khẩu GHCR lâu dài:
mỗi lần triển khai, workflow đăng nhập bằng `GITHUB_TOKEN` (tự hết hạn khi job
kết thúc) rồi đăng xuất.

---

## 7. VPS hoặc Amazon EC2

### 7.1 Chọn máy

- **Tối thiểu:** 1 vCPU, 2 GB RAM, 20 GB SSD, Ubuntu 24.04 LTS. Máy 1 GB RAM chạy
  được nhờ swap nhưng chậm khi PostgreSQL và Node cùng bận.
- **VPS tại Việt Nam:** độ trễ thấp nhất tới máy của nhân viên; thanh toán bằng VNĐ.
- **Amazon EC2:** chọn vùng **ap-southeast-1 (Singapore)**. Từ 15/7/2025, tài khoản
  AWS mới nhận 100 USD credit, thêm tới 100 USD khi dùng thử các dịch vụ (trong đó
  có EC2); gói Free kết thúc sau **6 tháng hoặc khi hết credit** ([AWS](https://aws.amazon.com/about-aws/whats-new/2025/07/aws-free-tier-credits-month-free-plan)).
  Sau đó là trả phí — đặt **AWS Budgets** để nhận cảnh báo chi phí.

### 7.2 Riêng với EC2

1. Launch instance: Ubuntu 24.04, `t3.small` (x86) hoặc `t4g.small` (ARM, rẻ hơn).
   Với ARM, đặt biến repo `DOCKER_PLATFORMS=linux/arm64` (mục 8.2).
2. **Elastic IP**: gắn để IP không đổi sau khi dừng/bật máy (bản ghi A trỏ vào IP này).
3. **Security Group** (tường lửa của AWS, lọc trước cả UFW):
   - SSH 22: chỉ IP nhà/văn phòng của bạn. GitHub Actions cũng cần SSH vào —
     dải IP của GitHub runner rất rộng và thay đổi; cách đơn giản là mở 22 cho mọi
     nơi nhưng **chỉ cho đăng nhập bằng khoá** (`HARDEN_SSH=1`) và để fail2ban chặn dò.
   - HTTPS 443: các dải IP trong <https://www.cloudflare.com/ips/>.
4. Ổ đĩa (EBS) 20–30 GB gp3.

### 7.3 Chuẩn bị máy bằng script

Trên **máy của bạn**, tạo cặp khoá SSH riêng cho GitHub Actions:
```bash
ssh-keygen -t ed25519 -f restomanager-ci -C "github-actions" -N ""
# restomanager-ci      → khoá RIÊNG, dán vào secret VPS_SSH_KEY (mục 8)
# restomanager-ci.pub  → khoá công khai, đưa lên VPS ngay dưới đây
```

Chép thư mục `deploy/cloud` lên VPS và chạy script chuẩn bị (bằng root, hoặc
`ubuntu` + `sudo` trên EC2):
```bash
scp -r deploy/cloud root@<IP_VPS>:/root/restomanager-setup
ssh root@<IP_VPS>
cd /root/restomanager-setup
sudo DEPLOY_PUBKEY="$(cat <<'K'
ssh-ed25519 AAAA...nội-dung-restomanager-ci.pub... github-actions
K
)" SSH_PORT=22 ./scripts/vps-setup.sh
```

Script sẽ: cập nhật hệ thống; cài Docker + Compose, UFW, fail2ban, tự cài bản vá
bảo mật; tạo tài khoản `deploy` (thuộc nhóm `docker`) với khoá SSH ở trên; tạo
`/opt/restomanager/{certs,backups}` và chép bộ cấu hình vào đó; tạo swap 2 GB; bật tường lửa **chỉ mở SSH và
443 cho dải IP Cloudflare**; cài tác vụ hằng tuần cập nhật dải IP đó.

Khi đã đăng nhập được bằng khoá, chạy lại với `HARDEN_SSH=1` để tắt đăng nhập
bằng mật khẩu (script tự từ chối nếu chưa có khoá nào, tránh tự khoá mình).

> **Vì sao Caddy chạy `network_mode: host`?** Cổng mà Docker publish ra
> `0.0.0.0` được Docker chèn luật iptables riêng, **đi vòng qua UFW** — mở 443 cho
> Cloudflare bằng UFW sẽ vô tác dụng. Chạy Caddy trên mạng của máy chủ thì UFW
> lọc được; backend và frontend chỉ mở trên `127.0.0.1` nên Internet không gọi
> thẳng được.

Kiểm tra:
```bash
ufw status numbered          # 22 + khoảng 22 dòng 443 "cloudflare-https"
docker compose version
```

---

## 8. CI/CD với GitHub Actions

CI/CD = tự động kiểm thử (Continuous Integration) và tự động triển khai
(Continuous Delivery/Deployment).

### 8.1 Luồng chạy

| Sự kiện | Workflow | Việc làm |
|---|---|---|
| Mở/cập nhật Pull Request | `ci.yml` | Unit test, kiểm tra ranh giới module, e2e + realtime (PostgreSQL và MinIO thật), build web, kiểm tra `deploy/cloud` (shellcheck, `caddy validate`, `compose config`), build thử 2 Dockerfile |
| Push lên `main` | `deploy.yml` | Chạy lại toàn bộ CI → build và đẩy 2 image lên GHCR → SSH vào VPS: chép `deploy/cloud`, đăng nhập GHCR tạm, chạy `release.sh` → gọi `https://<DOMAIN>/api/health/live` qua Cloudflare |
| Chạy tay *Deploy* với `image_tag` | `deploy.yml` | Bỏ qua test/build, triển khai lại đúng tag đó (dùng để rollback) |

`release.sh` trên VPS: kiểm tra `.env` → kéo image → **sao lưu CSDL** →
`docker compose up -d` → chờ `/api/health` (CSDL + R2) và frontend báo khoẻ →
thành công thì ghi `release.env`; thất bại thì **tự quay về tag trước**.

### 8.2 Cấu hình repo (một lần)

GitHub → repo → **Settings → Environments → New environment** `production`.
Có thể bật *Required reviewers* để mỗi lần triển khai cần bạn bấm duyệt.

**Environment secrets:**

| Tên | Giá trị |
|---|---|
| `VPS_HOST` | IP công khai của VPS (không dùng tên miền đi qua Cloudflare) |
| `VPS_USER` | `deploy` |
| `VPS_SSH_KEY` | Toàn bộ nội dung tệp `restomanager-ci` (khoá riêng) |
| `VPS_KNOWN_HOSTS` | Kết quả lệnh `ssh-keyscan -p 22 <IP_VPS>` chạy từ máy bạn — chống giả mạo máy chủ |

**Variables** (Settings → Secrets and variables → Actions → Variables):

| Tên | Ví dụ | Bắt buộc |
|---|---|---|
| `DOMAIN` | `nhahang.id.vn` | Nên có (để kiểm tra sau triển khai) |
| `VPS_PORT` | `22` | Không |
| `APP_DIR` | `/opt/restomanager` | Không |
| `DOCKER_PLATFORMS` | `linux/amd64` hoặc `linux/arm64` | Không (mặc định amd64) |

Thêm **Branch protection** cho `main` (Settings → Branches): bắt buộc qua
Pull Request và các job của `CI` phải xanh.

> Kiểm tra trước khi đẩy mã: `git status` không được có `.env`, `certs/`,
> `backups/` (đã nằm trong `.gitignore`).

---

## 9. Lần triển khai đầu tiên

Trên VPS, bằng tài khoản `deploy`:
```bash
ssh deploy@<IP_VPS>
cd /opt/restomanager
ls                                # compose.yml  Caddyfile  env.example  scripts/  certs/  backups/
ls certs/                         # origin.pem  origin.key  (mục 5.1)
cp env.example .env && chmod 600 .env && nano .env
```

Điền `.env` (mẫu ở `deploy/cloud/env.example`). Sinh chuỗi ngẫu nhiên:
```bash
openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48
```
- `DB_PASSWORD`, `JWT_SECRET`, `REFRESH_SECRET`, `GUEST_SECRET`: **bốn** chuỗi khác nhau.
- `SEED_ON_BOOT=true` và `SEED_PASSWORD` tạm (≥ 12 ký tự) — chỉ cho lần đầu.
- Phần R2 theo mục 4.

```bash
./scripts/check-env.sh            # phải ra "ĐẠT: 0 lỗi"
```

`.env` phải có **trước** lần triển khai đầu: `release.sh` gọi `check-env.sh` và
dừng nếu chưa đạt. Sau đó, trên máy bạn: đẩy mã lên `main` (hoặc merge Pull Request). Theo dõi tab
**Actions** → *Deploy*. Lần đầu mất khoảng 5–10 phút (build chưa có cache).

### Ngay sau lần đầu chạy được

1. Mở `https://nhahang.id.vn`, đăng nhập `admin` với `SEED_PASSWORD`.
2. **Đổi mật khẩu cả ba tài khoản.** Web chưa có màn hình đổi mật khẩu (lỗi C-03
   trong báo cáo), nên dùng API (mật khẩu mới ≥ `MIN_PASSWORD_LENGTH` = 10 ký tự):
   ```bash
   D=https://nhahang.id.vn
   for u in admin cashier waiter; do
     read -rsp "Mật khẩu mới cho $u: " NEW; echo
     TOKEN=$(curl -fsS $D/api/auth/login -H 'Content-Type: application/json' \
       -d "{\"username\":\"$u\",\"password\":\"<SEED_PASSWORD>\"}" | sed -E 's/.*"token":"([^"]+)".*/\1/')
     curl -fsS -X PUT $D/api/auth/password -H "Authorization: Bearer $TOKEN" \
       -H 'Content-Type: application/json' \
       -d "{\"current_password\":\"<SEED_PASSWORD>\",\"new_password\":\"$NEW\"}" && echo " → $u đã đổi"
   done
   ```
3. Trên VPS: sửa `.env` thành `SEED_ON_BOOT=false`, xoá dòng `SEED_PASSWORD`, rồi
   ```bash
   ./scripts/dc.sh up -d backend
   ```
4. Thử tải ảnh một món trong trang quản trị → ảnh phải hiện từ `https://img.nhahang.id.vn/...`.
5. Bật sao lưu ngoài máy chủ (nếu đã làm mục 4.3):
   ```bash
   ./scripts/dc.sh --profile offsite up -d
   ./scripts/dc.sh logs backup-offsite
   ```

### Kiểm tra tường lửa từ bên ngoài

Từ máy bạn (không qua Cloudflare):
```bash
curl -vk --max-time 5 https://<IP_VPS>/        # phải TIMEOUT — chỉ Cloudflare vào được
curl -fsS https://nhahang.id.vn/api/health/live # {"success":true,...}
curl -s -o /dev/null -w '%{http_code}\n' https://nhahang.id.vn/api/docs   # 404 — đã ẩn
```

---

## 10. Vận hành hằng ngày

Mọi lệnh chạy trong `/opt/restomanager` bằng tài khoản `deploy`.

| Việc | Lệnh |
|---|---|
| Trạng thái | `./scripts/dc.sh ps` (dịch vụ `backup` "unhealthy" = không có bản sao lưu nào trong 26 giờ) |
| Log | `./scripts/dc.sh logs -f --tail=100 backend` |
| Phiên bản đang chạy | `cat release.env` |
| Sức khoẻ chi tiết (chỉ trên VPS) | `curl -s http://127.0.0.1:3000/api/health` |
| Tài liệu API (qua đường hầm SSH) | Máy bạn: `ssh -L 3000:127.0.0.1:3000 deploy@<IP_VPS>` rồi mở `http://localhost:3000/api/docs` |
| Sao lưu ngay | `./scripts/dc.sh exec backup /bin/sh /usr/local/bin/backup.sh once` |
| Danh sách bản sao lưu | `ls -lh backups/` |
| Vào CSDL | `./scripts/dc.sh exec postgres psql -U postgres restaurant_db` |

### Rollback

GitHub → Actions → **Deploy** → **Run workflow** → nhập `image_tag` của bản cũ
(xem tag trong lịch sử Actions hoặc trang package GHCR, dạng `sha-4f2c1ab`).

`release.sh` chỉ đổi image. Nếu bản mới đã chạy migration làm đổi cấu trúc CSDL
mà bản cũ không hiểu, khôi phục từ bản `backups/pre-release-*.dump` tạo ngay
trước lần triển khai đó (bên dưới).

### Khôi phục CSDL

```bash
cd /opt/restomanager
./scripts/dc.sh stop backend                       # ngừng ghi mới
./scripts/dc.sh exec -T postgres pg_restore --clean --if-exists --no-owner \
  -U postgres -d restaurant_db < backups/restaurant_db-YYYYMMDD-030000.dump
./scripts/dc.sh start backend
```
Lấy bản từ R2 (bucket sao lưu): tải trong dashboard R2 hoặc `rclone copy`.
**Diễn tập khôi phục ít nhất mỗi quý** vào một CSDL thử — sao lưu chưa từng khôi
phục thử thì chưa chắc dùng được.

### Việc định kỳ

| Tần suất | Việc |
|---|---|
| Tự động hằng tuần | Cập nhật dải IP Cloudflare cho UFW (`/var/log/restomanager-cloudflare-ips.log`) |
| Tự động hằng ngày | Bản vá bảo mật Ubuntu (unattended-upgrades) |
| Hằng tháng | `df -h`, `./scripts/dc.sh ps`, xem log lỗi; dọn image cũ `docker image prune -a` |
| Hằng quý | Diễn tập khôi phục; rà Pull Request của Dependabot/`npm audit` |
| Trước ngày hết hạn | Gia hạn tên miền id.vn; chứng chỉ Origin CA (15 năm) |

Giám sát ngoài: tạo một monitor miễn phí (ví dụ UptimeRobot) gọi
`https://nhahang.id.vn/api/health/live` mỗi 5 phút.

---

## 11. Xử lý sự cố

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Lỗi **521** (Web server is down) | Caddy không chạy, hoặc UFW chặn nhầm | `./scripts/dc.sh ps caddy`, `logs caddy`; `ufw status` có các dòng 443 cloudflare-https không |
| Lỗi **522** (Connection timed out) | Tường lửa/Security Group chặn 443 từ Cloudflare; IP trong bản ghi A sai | Kiểm tra bản ghi A, Security Group (EC2), chạy lại `sudo /usr/local/sbin/restomanager-cloudflare-ips` |
| Lỗi **525** (SSL handshake failed) | Bật `origin_tls_aop` nhưng chưa bật Authenticated Origin Pulls trên dashboard; Caddy không nạp được chứng chỉ | Làm lại mục 5.2 đúng thứ tự; `./scripts/check-env.sh` |
| Lỗi **526** (Invalid SSL certificate) | Chứng chỉ không phải Origin CA của Cloudflare hoặc không chứa tên miền | Tạo lại theo mục 5.1 |
| Vòng chuyển hướng vô tận | SSL/TLS đang ở Flexible | Đặt **Full (strict)** |
| Web mở được, đăng nhập báo lỗi CORS / 403 `CORS_FORBIDDEN` | `ALLOWED_ORIGINS` không đúng `https://<DOMAIN>` | Sửa `.env`, `./scripts/dc.sh up -d backend` |
| Ảnh món không hiện | Chưa gắn custom domain `img.`; `S3_PUBLIC_URL` sai; ảnh tải lên trước khi đổi sang R2 | Mục 4.1; mục 4.4 |
| `release.sh` báo "không khoẻ" | `/api/health` 503: R2 sai khoá/bucket, hoặc CSDL lỗi | `curl -s http://127.0.0.1:3000/api/health`, xem mục `checks.storage` |
| Backend không khởi động, log có `[config][FATAL]` | Secret còn giá trị mẫu/ngắn/trùng; `SEED_ON_BOOT=true` với mật khẩu yếu | Sửa theo đúng thông báo; `./scripts/check-env.sh` |
| Job Deploy: `Host key verification failed` | `VPS_KNOWN_HOSTS` sai hoặc VPS cài lại | Chạy lại `ssh-keyscan`, cập nhật secret |
| Job Deploy: `denied` khi pull image | Package GHCR không cho repo truy cập | GitHub → Packages → package → Package settings → *Manage Actions access* → thêm repo |
| Màn hình không tự cập nhật | WebSocket bị tắt trên Cloudflare | Network → WebSockets: On |
| Thao tác liên tục bị 429 | Cả nhà hàng chung một IP công cộng (lỗi H-06) | Tăng `RL_API_MAX` trong `.env` (mẫu đã đặt 600) |

---

## 12. Những gì đã và chưa được kiểm chứng

**Đã chạy thật trong môi trường review** (Node.js 22, PostgreSQL 16, Caddy 2.8.4,
BusyBox 1.36.1, rclone 1.68.2, máy chủ S3 giả lập):
- Backend ở chế độ `production` với `STORAGE_DRIVER=r2`: bỏ qua tạo bucket, tải
  ảnh được, URL dạng `https://img.<domain>/menu/...`; health báo đúng khi sai
  bucket, sai cổng, bucket rỗng.
- Kiểm tra cấu hình: chặn khoá mẫu của `.env.example`, khoá trùng nhau,
  `SEED_PASSWORD` yếu ở production; chế độ phát triển vẫn chạy.
- 24/24 unit test, kiểm tra ranh giới module, 75/75 e2e, 10/10 realtime sau khi sửa.
- Caddyfile: định tuyến web/API/WebSocket, ẩn `/api/docs`, `/api/health`…,
  chuyển hướng `www`, không mở cổng 80, từ chối tên miền lạ; Authenticated Origin
  Pulls từ chối kết nối không có hoặc sai chứng chỉ client; lấy IP thật từ
  `CF-Connecting-IP` (dùng CA tự tạo thay cho Cloudflare).
- `backup.sh` trên BusyBox với `pg_dump` thật: sao lưu, từ chối tệp hỏng, tính
  đúng giờ kế tiếp, xoá bản cũ; khôi phục bằng `pg_restore` thành công.
- `release.sh` với Docker giả lập: lần đầu, cập nhật, tự rollback khi bản mới
  hỏng, dừng khi thiếu image hoặc `.env` sai.
- `check-env.sh`, `cloudflare-ips.sh` (chế độ in lệnh), `docker compose config`,
  `actionlint` + `shellcheck` cho cả hai workflow, rclone đẩy bản sao lưu lên S3.

**Chưa kiểm chứng được** (môi trường review không có Cloudflare, R2, GitHub
Actions, VPS thật, và không tải được image Docker):
- Chạy thật trên Cloudflare + R2 + GHCR + GitHub Actions; UFW trên máy thật.
- Quyền thực tế của token R2 "Object Read & Write" với thao tác liệt kê đối tượng
  (theo mô tả của Cloudflare là có).
- Image `rclone/rclone:1.68` và `caddy:2.8-alpine` trong Docker thật.

Lần triển khai đầu tiên chính là bài kiểm tra cuối: theo dõi kỹ job *Deploy* và
chạy các lệnh ở cuối mục 9.
