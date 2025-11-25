#!/bin/sh
set -e

# Generate Prisma Client
pnpm prisma generate

# Resolve any failed migrations (mark as rolled back so they can be retried)
pnpm prisma migrate resolve --rolled-back 20240530213853_create_session_table 2>/dev/null || true
pnpm prisma migrate resolve --rolled-back 20251121011021_add_bynder_models 2>/dev/null || true
pnpm prisma migrate resolve --rolled-back 20251121225010_remove_oauth_token_fields 2>/dev/null || true

# Deploy migrations
pnpm prisma migrate deploy



