/*
  Warnings:

  - You are about to drop the column `bynderAccessToken` on the `Shop` table. All the data in the column will be lost.
  - You are about to drop the column `bynderRefreshToken` on the `Shop` table. All the data in the column will be lost.
  - You are about to drop the column `bynderTokenExpires` on the `Shop` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Shop" DROP COLUMN "bynderAccessToken",
DROP COLUMN "bynderRefreshToken",
DROP COLUMN "bynderTokenExpires";
