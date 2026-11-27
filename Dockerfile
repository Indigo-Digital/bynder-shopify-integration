# Pinned by digest so a re-pushed tag cannot change the image; keep the Node
# and pnpm versions in step with .github/workflows/ci-cd.yml.
FROM node:20.20.2-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
RUN apk add --no-cache openssl

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

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

CMD ["pnpm", "run", "docker-start"]
