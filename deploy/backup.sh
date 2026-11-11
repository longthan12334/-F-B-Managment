#!/bin/sh
# =============================================================================
#  Sao lưu PostgreSQL hằng ngày
# -----------------------------------------------------------------------------
#  Chạy như một dịch vụ thường trú (không dùng cron của host) để toàn bộ lịch
#  sao lưu nằm trong docker-compose — chuyển sang VPS khác là mang theo luôn.
#
#  Chiến lược:
#    • Dump lúc 03:00 giờ Việt Nam (giờ vắng khách nhất).
#    • Nén gzip, đặt tên theo ngày.
#    • Giữ RETENTION_DAYS ngày gần nhất (mặc định 14).
#    • Dump NGAY khi container khởi động lần đầu, để không phải chờ tới 03:00
#      mới có bản sao lưu đầu tiên.
#
#  ⚠ Bản sao lưu nằm trên CÙNG MỘT VPS. Ổ đĩa hỏng là mất cả hai. Hãy đồng bộ
#    thư mục ./backups sang nơi khác — xem DEPLOYMENT.md mục 7.
# =============================================================================
set -eu

BACKUP_DIR=/backups
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

log() { echo "[backup] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

do_backup() {
  ts=$(date '+%Y%m%d-%H%M%S')
  file="$BACKUP_DIR/${PGDATABASE}-${ts}.sql.gz"

  log "Bắt đầu dump → $(basename "$file")"
  if pg_dump --no-owner --no-acl --clean --if-exists | gzip -9 > "$file.tmp"; then
    mv "$file.tmp" "$file"
    size=$(du -h "$file" | cut -f1)
    log "Hoàn tất ($size)"
  else
    rm -f "$file.tmp"
    log "LỖI: dump thất bại"
    return 1
  fi

  # Dọn bản cũ
  removed=$(find "$BACKUP_DIR" -name "${PGDATABASE}-*.sql.gz" -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)
  [ "$removed" -gt 0 ] && log "Đã xoá $removed bản sao lưu cũ hơn ${RETENTION_DAYS} ngày"

  log "Hiện có $(ls -1 "$BACKUP_DIR"/${PGDATABASE}-*.sql.gz 2>/dev/null | wc -l) bản sao lưu"
}

# Giây còn lại tới 03:00 kế tiếp
seconds_until_3am() {
  now=$(date '+%s')
  today3=$(date -d 'today 03:00' '+%s' 2>/dev/null || date -v3H -v0M -v0S '+%s')
  if [ "$now" -lt "$today3" ]; then
    echo $((today3 - now))
  else
    echo $((today3 + 86400 - now))
  fi
}

log "Dịch vụ sao lưu khởi động (giữ ${RETENTION_DAYS} ngày, CSDL: ${PGDATABASE})"

# Chờ PostgreSQL sẵn sàng
until pg_isready -q; do
  log "Chờ PostgreSQL..."
  sleep 3
done

# Sao lưu ngay lần đầu
do_backup || log "Bỏ qua lỗi lần đầu, sẽ thử lại vào 03:00"

while true; do
  wait_sec=$(seconds_until_3am)
  log "Lần sao lưu kế tiếp sau $((wait_sec / 3600))h $(((wait_sec % 3600) / 60))p"
  sleep "$wait_sec"
  do_backup || log "Sao lưu thất bại, sẽ thử lại vào 03:00 ngày mai"
done
