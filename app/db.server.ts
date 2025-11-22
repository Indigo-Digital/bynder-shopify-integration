import { PrismaClient } from "@prisma/client";
import { initializeQuietLogging } from "./lib/logger.server.js";

// Initialize quiet logging early to filter HTTP request logs
initializeQuietLogging();

declare global {
	// eslint-disable-next-line no-var
	var prismaGlobal: PrismaClient;
	var migrationChecked: boolean;
}

if (process.env.NODE_ENV !== "production") {
	if (!global.prismaGlobal) {
		global.prismaGlobal = new PrismaClient();
	}
}

const prisma = global.prismaGlobal ?? new PrismaClient();

/**
 * Check if database migration is needed and apply it automatically
 * This checks if the new SyncJob fields exist, and if not, adds them using raw SQL
 */
async function checkAndApplyMigration() {
	// Only check once per process
	if (global.migrationChecked) {
		return;
	}
	global.migrationChecked = true;

	try {
		// Try to query with new fields to see if they exist
		await prisma.$queryRaw`
			SELECT "assetsCreated", "assetsUpdated", "errors" 
			FROM "SyncJob" 
			LIMIT 1
		`;
		// If we get here, the fields exist - migration already applied
		return;
	} catch (error) {
		// Fields don't exist - need to add them
		if (
			error instanceof Error &&
			(error.message.includes("no such column") ||
				error.message.includes("Unknown column") ||
				(error.message.includes("column") &&
					error.message.includes("does not exist")))
		) {
			console.log(
				"Detected missing database columns. Applying migration automatically..."
			);
			try {
				// Detect database type from connection string
				const dbUrl = process.env.DATABASE_URL || "";
				const isPostgreSQL =
					dbUrl.includes("postgres") || dbUrl.includes("postgresql");
				const intType = isPostgreSQL ? "INT" : "INTEGER";

				// Add columns - handle both PostgreSQL (IF NOT EXISTS) and SQLite
				const addColumn = async (columnDef: string, columnName: string) => {
					try {
						if (isPostgreSQL) {
							// PostgreSQL supports IF NOT EXISTS
							await prisma.$executeRawUnsafe(
								`ALTER TABLE "SyncJob" ADD COLUMN IF NOT EXISTS ${columnDef}`
							);
						} else {
							// SQLite doesn't support IF NOT EXISTS, so catch duplicate errors
							await prisma.$executeRawUnsafe(
								`ALTER TABLE "SyncJob" ADD COLUMN ${columnDef}`
							);
						}
						console.log(`Added column: ${columnName}`);
					} catch (err) {
						// Column might already exist (race condition or already added)
						if (
							err instanceof Error &&
							(err.message.includes("duplicate column") ||
								err.message.includes("already exists") ||
								(err.message.includes("column") &&
									err.message.includes("already exists")))
						) {
							console.log(`Column ${columnName} already exists, skipping`);
							return;
						}
						throw err;
					}
				};

				await addColumn('"errors" TEXT', "errors");
				await addColumn(
					`"assetsCreated" ${intType} NOT NULL DEFAULT 0`,
					"assetsCreated"
				);
				await addColumn(
					`"assetsUpdated" ${intType} NOT NULL DEFAULT 0`,
					"assetsUpdated"
				);
				console.log("Migration applied successfully!");
			} catch (migrationError) {
				console.error("Failed to apply migration:", migrationError);
				// Don't throw - let the app continue with fallback behavior
			}
		}
	}
}

// Check migration on module load
// Run asynchronously to not block startup
checkAndApplyMigration().catch((error) => {
	console.error("Error checking migration:", error);
});

export default prisma;
