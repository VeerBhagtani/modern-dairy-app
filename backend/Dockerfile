# Cloud Run container for the Modern Dairy backend.
# Multi-stage: install production deps against the lockfile, then a slim runtime.
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
# Cloud Run provides PORT; src/index.js already listens on process.env.PORT || 8080.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
EXPOSE 8080
CMD ["node", "src/index.js"]
