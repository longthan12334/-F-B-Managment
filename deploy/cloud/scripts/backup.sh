#!/bin/sh
# =============================================================================
#  Sao lưu PostgreSQL hằng ngày — chạy trong container postgres:16-alpine
# -----------------------------------------------------------------------------
#  Viết cho /bin/sh của BusyBox (ảnh Alpine), không dùng tuỳ chọn riêng của GNU:
#    • Tính giờ chạy kế tiếp bằng `date -d "YYYY-MM-DD HH:MM:SS"` (BusyBox hiểu),
#      không dùng `date -d 'today 03:00'` (chỉ GNU hiểu) — đây là lỗi H-08 cũ.
#    • Dump ra tệp tạm rồi kiểm tra bằng `pg_restore --list` trước khi giữ lại,
#      thay vì `pg_dump | gzip` (lỗi của pg_dump bị gzip che mất).
#    • Lỗi một lần sao lưu chỉ ghi log và chờ lần sau — container KHÔNG thoát,
#      nên không rơi vào vòng lặp khởi động lại liên tục.
#
#  Cách dùng:
#    backup.sh          chạy thường trú: sao lưu lúc BACKUP_HOUR giờ mỗi ngày
#    backup.sh once     sao lưu một lần rồi thoát (dùng khi cần bản sao ngay)
#
#  Biến môi trường: PGHOST PGUSER PGPASSWORD PGDATABASE (chuẩn của libpq),
#    BACKUP_DIR (mặc định /backups), RETENTION_DAYS (14), BACKUP_HOUR (3),
#    BACKUP_ON_START (true), MIN_BACKUP_BYTES (1024).
#
#  Định dạng: pg_dump -Fc (đã nén). Khôi phục:
#    pg_restore --clean --if-exists --no-owner -d restaurant_db <tệp.dump>
# =============================================================================
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
BACKUP_HOUR="${BACKUP_HOUR:-3}"
BACKUP_ON_START="${BACKUP_ON_START:-true}"
MIN_BACKUP_BYTES="${MIN_BACKUP_BYTES:-1024}"
DB_NAME="${PGDATABASE:-restaurant_db}"

log() { echo "[backup] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# Sao lưu một lần. Trả về 0 nếu thành công, 1 nếu thất bại (không thoát script).
backup_once() {
  ts=$(date '+%Y%m%d-%H%M%S')
  final="$BACKUP_DIR/${DB_NAME}-${ts}.dump"
  tmp="$BACKUP_DIR/.${DB_NAME}-${ts}.dump.part"

  mkdir -p "$BACKUP_DIR"
  if ! pg_dump --format=custom --no-owner --no-privileges --file="$tmp" "$DB_NAME"; then
    log "LỖI: pg_dump thất bại — không có bản sao lưu mới."
    rm -f "$tmp"
    return 1
  fi

  size=$(wc -c < "$tmp" | tr -d ' ')
  if [ "$size" -lt "$MIN_BACKUP_BYTES" ]; then
    log "LỖI: tệp dump chỉ có $size byte (< $MIN_BACKUP_BYTES) — nghi hỏng, đã bỏ."
    rm -f "$tmp"
    return 1
  fi

  # Đọc được mục lục nghĩa là tệp dump hoàn chỉnh, khôi phục được.
  if ! pg_restore --list "$tmp" > /dev/null 2>&1; then
    log "LỖI: pg_restore không đọc được tệp dump — đã bỏ."
    rm -f "$tmp"
    return 1
  fi

  mv "$tmp" "$final"
  log "Hoàn tất: $(basename "$final") ($size byte)"

  # Xoá bản cũ. Dùng -exec rm thay cho -delete để chạy được với mọi bản find.
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_NAME}-*.dump" \
    -mtime +"$RETENTION_DAYS" -exec rm -f {} \; || true
  find "$BACKUP_DIR" -maxdepth 1 -type f -name ".${DB_NAME}-*.dump.part" \
    -mmin +120 -exec rm -f {} \; || true
  return 0
}

# Số giây từ bây giờ tới BACKUP_HOUR:00 kế tiếp (hôm nay hoặc ngày mai).
seconds_until_next_run() {
  now=$(date +%s)
  today=$(date +%Y-%m-%d)
  target=$(date -d "$today $(printf '%02d' "$BACKUP_HOUR"):00:00" +%s)
  if [ "$target" -le "$now" ]; then
    target=$((target + 86400))
  fi
  echo $((target - now))
}

case "${1:-daemon}" in
  once)
    backup_once
    ;;
  next)
    # Phục vụ kiểm thử: in số giây tới lần chạy kế tiếp.
    seconds_until_next_run
    ;;
  daemon)
    log "Khởi động: sao lưu '$DB_NAME' lúc ${BACKUP_HOUR}:00 mỗi ngày, giữ $RETENTION_DAYS ngày."
    if [ "$BACKUP_ON_START" = "true" ]; then
      backup_once || true
    fi
    while true; do
      wait_s=$(seconds_until_next_run)
      if [ "$wait_s" -le 0 ] || [ "$wait_s" -gt 86400 ]; then
        # Phòng xa: nếu tính giờ hỏng thì chờ 1 giờ rồi tính lại, không thoát.
        log "CẢNH BÁO: tính giờ kế tiếp ra $wait_s giây — chờ 3600 giây rồi thử lại."
        wait_s=3600
      fi
      log "Lần sao lưu kế tiếp sau $((wait_s / 3600))h$(((wait_s % 3600) / 60))p."
      sleep "$wait_s"
      backup_once || true
    done
    ;;
  *)
    echo "Dùng: $0 [daemon|once|next]" >&2
    exit 2
    ;;
esac
