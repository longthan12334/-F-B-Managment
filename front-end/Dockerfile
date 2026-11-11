# =============================================================================
#  Frontend — React 18 + Vite 5, phục vụ bởi Nginx
# -----------------------------------------------------------------------------
#  Multi-stage: build bằng Node rồi CHỈ copy thư mục dist sang ảnh Nginx.
#  Ảnh cuối không chứa Node, không chứa node_modules, không chứa mã nguồn —
#  nhỏ hơn khoảng 20 lần và không có bề mặt tấn công từ các gói npm.
# =============================================================================

# ─── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund

COPY . .

# Cho phép trỏ API sang host khác khi cần (mặc định: cùng origin)
ARG VITE_API_BASE=""
ENV VITE_API_BASE=$VITE_API_BASE

RUN npm run build

# ─── Stage 2: phục vụ ────────────────────────────────────────────────────────
FROM nginx:1.27-alpine

RUN apk add --no-cache wget

COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
