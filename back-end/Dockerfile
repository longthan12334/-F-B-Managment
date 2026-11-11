# =============================================================================
#  Backend — Node.js 20 Alpine, multi-stage
# -----------------------------------------------------------------------------
#  Stage `deps`    : cài phụ thuộc production, tách riêng để tận dụng cache
#                    Docker (đổi mã nguồn không phải cài lại npm).
#  Stage `runtime` : ảnh cuối, chạy bằng user không phải root.
#
#  Ba điểm đáng chú ý về bảo mật/vận hành:
#    • `USER node`  — không chạy bằng root; nếu ứng dụng bị khai thác, kẻ tấn
#      công không có quyền root trong container.
#    • `tini`       — init process thật, chuyển tiếp SIGTERM để Node tắt êm
#      (không có nó, PID 1 là Node và Docker phải SIGKILL sau 10 giây).
#    • HEALTHCHECK  — Compose chờ backend thực sự sẵn sàng rồi mới coi là khoẻ.
# =============================================================================

# ─── Stage 1: phụ thuộc ──────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund

# ─── Stage 2: ảnh chạy ───────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN apk add --no-cache tini curl

ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node tools ./tools

USER node

EXPOSE 3000

# Dùng endpoint liveness: nhẹ, không chạm CSDL, phản ánh đúng "tiến trình sống"
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=4 \
  CMD curl -fsS http://127.0.0.1:3000/api/health/live || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
