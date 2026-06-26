# syntax=docker/dockerfile:1

# --- Stage 1: install deps and build inside the image -----------------------
# Dependencies are installed in the image (not copied from the host) so the
# build is reproducible and platform-correct regardless of the host OS.
FROM node:20-alpine AS build

WORKDIR /app

# Enable the pinned pnpm from package.json#packageManager via corepack.
RUN corepack enable

# Install dependencies first (cached layer keyed on the lockfile).
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# Build the TypeScript sources (also copies migrations + help templates into dist).
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN pnpm build

# Drop dev dependencies so only runtime deps are carried into the final image.
RUN pnpm prune --prod

# --- Stage 2: minimal runtime image ----------------------------------------
FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PROJECT_MEMORY_HTTP_HOST=0.0.0.0
ENV PROJECT_MEMORY_HTTP_PORT=8788

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY examples ./examples

EXPOSE 8788

CMD ["node", "dist/http/server.js"]
