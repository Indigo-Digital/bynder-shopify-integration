import { PrismaClient } from "@prisma/client";

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
				// Check database type and add columns accordingly
				// SQLite doesn't support IF NOT EXISTS, so we need to handle errors
				const addColumn = async (columnDef: string) => {
					try {
						await prisma.$executeRawUnsafe(
							`ALTER TABLE "SyncJob" ADD COLUMN ${columnDef}`
						);
					} catch (err) {
						// Column might already exist (race condition or already added)
						if (
							err instanceof Error &&
							!err.message.includes("duplicate column")
						) {
							throw err;
						}
					}
				};

				await addColumn('"errors" TEXT');
				await addColumn('"assetsCreated" INTEGER NOT NULL DEFAULT 0');
				await addColumn('"assetsUpdated" INTEGER NOT NULL DEFAULT 0');
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
