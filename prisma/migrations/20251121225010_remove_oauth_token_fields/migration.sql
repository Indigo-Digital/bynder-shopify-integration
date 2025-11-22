/*
  Warnings:

  - You are about to drop the column `bynderAccessToken` on the `Shop` table. All the data in the column will be lost.
  - You are about to drop the column `bynderRefreshToken` on the `Shop` table. All the data in the column will be lost.
  - You are about to drop the column `bynderTokenExpires` on the `Shop` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "bynderBaseUrl" TEXT,
    "syncTags" TEXT NOT NULL DEFAULT 'shopify-sync',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Shop" ("bynderBaseUrl", "createdAt", "id", "shop", "syncTags", "updatedAt") SELECT "bynderBaseUrl", "createdAt", "id", "shop", "syncTags", "updatedAt" FROM "Shop";
DROP TABLE "Shop";
ALTER TABLE "new_Shop" RENAME TO "Shop";
CREATE UNIQUE INDEX "Shop_shop_key" ON "Shop"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
