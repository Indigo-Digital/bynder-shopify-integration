# Pinned by digest so a retagged node image cannot replace the runtime.
# To upgrade, resolve the new multi-arch index digest and update both the tag and digest.
FROM node:20.20.2-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
RUN apk add --no-cache openssl

# Install a pinned pnpm into a shared location so the non-root runtime user can use it
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate && chmod -R a+rX "$COREPACK_HOME"

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile && pnpm store prune

COPY . .

# Use PostgreSQL schema for production
RUN cp prisma/schema.postgresql.prisma prisma/schema.prisma
# Update migration lock to PostgreSQL for production
RUN echo 'provider = "postgresql"' > prisma/migrations/migration_lock.toml
# Make setup script executable
RUN chmod +x scripts/setup-db.sh

# Generate Prisma Client before building
RUN pnpm prisma generate

RUN pnpm run build

RUN CI=true pnpm prune --prod

# scripts/setup-db.sh regenerates the Prisma client at startup, so only that
# directory is writable by the runtime user; the rest of /app stays root-owned.
RUN chown -R 1000:1000 "$(node -p "const p = require('node:path'); p.dirname(require.resolve('.prisma/client/package.json', { paths: [p.dirname(require.resolve('@prisma/client/package.json'))] }))")"

# Numeric so the runtime user cannot be remapped through the image's /etc/passwd
USER 1000:1000

CMD ["pnpm", "run", "docker-start"]
