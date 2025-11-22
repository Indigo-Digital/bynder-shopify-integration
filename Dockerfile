FROM node:20-alpine
RUN apk add --no-cache openssl

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

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

RUN pnpm run build

RUN CI=true pnpm prune --prod

CMD ["pnpm", "run", "docker-start"]
