# =============================================================================
#  Dockerfile customer-api (.NET 10) — single project, multi-stage, non-root
#  Áp dụng Buổi 5 (least privilege) + Buổi 6 (multi-stage build)
#
#  Build context = ./customer-api
# =============================================================================

# ─── Stage 1: build ─────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Cache nuget layer: copy csproj trước, restore riêng
COPY ["RestoManager.CustomerApi.csproj", "./"]
RUN dotnet restore RestoManager.CustomerApi.csproj

# Copy toàn bộ source + publish
COPY . .
RUN dotnet publish RestoManager.CustomerApi.csproj \
    -c Release \
    -o /app/publish \
    --no-restore \
    /p:UseAppHost=false

# ─── Stage 2: runtime (aspnet runtime, ~200MB) ──────────────────────────────
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime

# Buổi 5: least privilege — tạo user non-root
RUN groupadd --system --gid 1001 appgroup \
 && useradd  --system --uid 1001 --gid appgroup --home /app --shell /sbin/nologin appuser

WORKDIR /app
COPY --from=build --chown=appuser:appgroup /app/publish ./

USER appuser

EXPOSE 5000
ENV ASPNETCORE_URLS=http://+:5000 \
    ASPNETCORE_ENVIRONMENT=Production \
    DOTNET_RUNNING_IN_CONTAINER=true

ENTRYPOINT ["dotnet", "RestoManager.CustomerApi.dll"]
