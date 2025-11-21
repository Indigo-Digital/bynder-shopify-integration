# Bynder Shopify Integration

A Shopify app that integrates Bynder Digital Asset Management (DAM) with Shopify, allowing merchants to sync and manage assets from Bynder directly in their Shopify store.

## Features

- Connect Bynder account to Shopify
- Sync assets from Bynder to Shopify Files
- Manage asset metadata and tags
- Automated sync capabilities

## Prerequisites

- Node.js >=20.19 <22 || >=22.12
- pnpm (package manager)
- Shopify Partner Account
- Shopify CLI
- Bynder API credentials

## Setup

1. Install dependencies:
```shell
pnpm install
```

2. Set up environment variables:
```shell
cp .env.example .env
```

3. Configure your Bynder API credentials in the `.env` file

4. Set up the database:
```shell
pnpm run setup
```

## Development

Start the development server:
```shell
pnpm run dev
```

Press `P` to open the URL to your app. Once you click install, you can start development.

## Available Scripts

- `pnpm run dev` - Start development server
- `pnpm run build` - Build for production
- `pnpm run start` - Start production server
- `pnpm run lint` - Run Biome linter
- `pnpm run format` - Format code with Biome
- `pnpm run test` - Run tests
- `pnpm run typecheck` - Run TypeScript type checking

## Project Structure

- `app/` - Application code (routes, components, lib)
- `extensions/` - Shopify app extensions
- `prisma/` - Database schema and migrations
- `public/` - Static assets

## Tech Stack

- React Router v7
- Shopify App Bridge
- Prisma (database)
- Biome (linting & formatting)
- Vitest (testing)
- TypeScript

## License

Private project
