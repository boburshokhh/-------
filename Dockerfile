# ============================================================
# AI Test Generator — production image (Node + OCR deps)
# ============================================================
FROM node:20-bookworm-slim AS base

# GraphicsMagick + Ghostscript для OCR отсканированных PDF
RUN apt-get update && apt-get install -y --no-install-recommends \
    graphicsmagick \
    ghostscript \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Зависимости backend
COPY backend/package.json backend/package-lock.json* ./backend/
RUN cd backend && npm ci --omit=dev

# Код backend и статика frontend
COPY backend ./backend
COPY frontend ./frontend

WORKDIR /app/backend

ENV NODE_ENV=production
EXPOSE 3000

# Данные (БД, загрузки) монтируются в /data через volume
ENV DATA_DIR=/data

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));"

CMD ["node", "server.js"]
