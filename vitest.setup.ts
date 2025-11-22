import "@testing-library/jest-dom";
import { vi } from "vitest";

// Mock environment variables
process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-api-secret";
process.env.SHOPIFY_APP_URL = "https://test.example.com";
process.env.BYNDER_PERMANENT_TOKEN = "test-bynder-permanent-token";
process.env.BYNDER_CLIENT_ID = "test-bynder-client-id";
process.env.BYNDER_CLIENT_SECRET = "test-bynder-client-secret";

// Mock Prisma
vi.mock("./app/db.server", () => ({
	default: {
		shop: {
			findUnique: vi.fn(),
			findMany: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			upsert: vi.fn(),
		},
		syncedAsset: {
			findUnique: vi.fn(),
			findMany: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			upsert: vi.fn(),
		},
		syncJob: {
			create: vi.fn(),
			update: vi.fn(),
			findMany: vi.fn(),
		},
		$queryRaw: vi.fn(),
	},
}));
