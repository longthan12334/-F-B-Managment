# =============================================================================
#  Dockerfile backend (Node.js) — multi-stage + non-root user
#  Buổi 5 (least privilege) + Buổi 6 (multi-stage)
# =============================================================================

# ─── Stage 1: install deps ──────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ─── Stage 2: runtime ───────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
RUN apk add --no-cache tini
WORKDIR /app

# Copy deps từ stage 1 + source. node:20-alpine đã có sẵn user `node` (uid 1000).
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

# Buổi 5: least privilege — không chạy root.
USER node

EXPOSE 3000
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","server.js"]
