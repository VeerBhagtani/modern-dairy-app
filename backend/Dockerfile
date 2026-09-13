# Cloud Run container for the Modern Dairy backend.
# Multi-stage: install production deps against the lockfile, then a slim runtime.
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: a dependency's install hook runs arbitrary code at build
# time with whatever the builder can reach. Nothing here needs one — every
# production dependency is pure JS or protobuf, verified by installing this way
# and loading express, firebase-admin, bcryptjs and secret-manager.
RUN npm ci --omit=dev --ignore-scripts

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
# Cloud Run provides PORT; src/index.js already listens on process.env.PORT || 8080.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
# Drop root. The image defaults to running as root, so any code execution bug
# in a public-facing service started with full container privileges — able to
# write over its own source and node_modules. `node` is a non-root user the
# base image already provides; the app only ever reads its own files and
# listens on a port, so it needs nothing more.
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
