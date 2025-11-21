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

RUN pnpm run build

RUN pnpm prune --prod

CMD ["pnpm", "run", "docker-start"]
