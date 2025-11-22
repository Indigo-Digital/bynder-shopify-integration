# Deployment Guide - Fly.io with Managed Postgres

## Initial Setup

### 1. Create the Fly.io App

First, create the Fly.io app (if you haven't already):

```bash
fly launch --no-deploy
```

**Important:** When prompted about Postgres, answer **"No"** or **"n"** - you'll attach to your existing cluster in the next step.

This will:
- Create a `fly.toml` configuration file (already created for you)
- Set up the app in your Fly.io account
- **Not deploy yet** (we'll do that after setting up the database)
- **Not create a new Postgres instance** (you'll use your existing one)

**Alternative:** If you want to skip all prompts, create the app directly:

```bash
fly apps create bynder-shopify-integration
```

### 2. Link to Your Managed Postgres Database

Attach your existing managed Postgres instance (use `fly mpg attach` for Managed Postgres):

```bash
fly mpg attach 9jknq035dkqr68w3 --app bynder-shopify-integration
```

Or using the cluster name:
```bash
fly mpg attach indigo-merchandising-tools-db --app bynder-shopify-integration
```

This will automatically:
- Create a new database in your existing Postgres cluster (`indigo-merchandising-tools-db`)
- Set the `DATABASE_URL` secret for your app
- Configure the connection
- **Use your existing cluster** - no new Postgres instance will be created

**Optional:** Specify a database name:
```bash
fly mpg attach 9jknq035dkqr68w3 --app bynder-shopify-integration --database bynder_shopify
```

**OR** if you prefer to set it manually:

1. Create a database in your Postgres instance:
   ```sql
   CREATE DATABASE bynder_shopify;
   ```

2. Get the connection string and set it as a secret:
   ```bash
   fly secrets set DATABASE_URL="postgresql://user:password@host:5432/bynder_shopify" --app bynder-shopify-integration
   ```

## Database Setup

### Option 1: Use Your Existing Managed Postgres Instance (Recommended)

1. **Create a new database** in your managed Postgres instance (`indigo-merchandising-tools-db`):
   ```sql
   CREATE DATABASE bynder_shopify;
   ```

2. **Get the connection string** from Fly.io:
   - Format: `postgresql://user:password@host:5432/bynder_shopify`
   - You can get this from your Fly.io Postgres instance settings

3. **Set DATABASE_URL in Fly.io**:
   ```bash
   fly secrets set DATABASE_URL="postgresql://user:password@host:5432/bynder_shopify"
   ```

### Option 2: Use Fly.io Postgres (Alternative)

If you prefer a separate Postgres instance:
```bash
fly postgres create --name bynder-shopify-db
fly postgres attach --app your-app-name bynder-shopify-db
```

## Prisma Schema Setup

The project uses **SQLite for local development** and **PostgreSQL for production**.

### Automatic Schema Switching

The `Dockerfile` automatically switches to PostgreSQL schema during the build:
- Local development: Uses `schema.prisma` (SQLite)
- Production build: Automatically copies `schema.postgresql.prisma` to `schema.prisma`

**No manual steps needed!** The Dockerfile handles this automatically.

### Migration Process in Fly.io

The `Dockerfile` runs `pnpm run docker-start` which executes:
1. Switches to PostgreSQL schema (automatic)
2. `pnpm run setup` → `prisma generate && prisma migrate deploy`
3. `pnpm run start` → starts the server

This means:
- ✅ Migrations run automatically on every deployment
- ✅ Your managed Postgres database will be updated with the latest schema
- ✅ No manual migration steps needed
- ✅ Schema switching happens automatically in Docker build

## Environment Variables in Fly.io

Set all required environment variables (after creating the app):

```bash
fly secrets set \
  SHOPIFY_API_KEY="your_key" \
  SHOPIFY_API_SECRET="your_secret" \
  SHOPIFY_APP_URL="https://bynder-shopify-integration.fly.dev" \
  BYNDER_PERMANENT_TOKEN="your_token" \
  BYNDER_CLIENT_ID="your_client_id" \
  BYNDER_CLIENT_SECRET="your_client_secret" \
  --app bynder-shopify-integration
```

**Note:** `DATABASE_URL` will be set automatically if you use `fly postgres attach`, or set it manually as shown in step 2 above.

## Deploy

Once everything is configured:

```bash
fly deploy --app bynder-shopify-integration
```

This will:
1. Build the Docker image
2. Switch to PostgreSQL schema automatically
3. Run migrations (`prisma migrate deploy`)
4. Start the app

## Important Notes

1. **Database Isolation**: Creating a separate database (`bynder_shopify`) in your managed instance is recommended for:
   - Data isolation
   - Easier backups
   - Clear separation of concerns

2. **Migrations**: The `prisma migrate deploy` command is safe for production:
   - Only applies pending migrations
   - Won't reset your database
   - Idempotent (safe to run multiple times)

3. **Local Development**: Keep using SQLite locally:
   - Faster for development
   - No need for Postgres running locally
   - Schema differences are minimal (Prisma handles most of it)

4. **Schema Sync**: If you make schema changes:
   - Test locally with SQLite
   - Create migration: `pnpm prisma migrate dev --name your_migration_name`
   - **Update both schema files** to keep them in sync:
     - Update `prisma/schema.prisma` (SQLite for dev)
     - Update `prisma/schema.postgresql.prisma` (PostgreSQL for production)
   - Fly.io will automatically apply the migration on deploy

