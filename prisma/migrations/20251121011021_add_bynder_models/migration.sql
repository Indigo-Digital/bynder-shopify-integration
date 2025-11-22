-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "bynderAccessToken" TEXT,
    "bynderRefreshToken" TEXT,
    "bynderTokenExpires" TIMESTAMP(3),
    "bynderBaseUrl" TEXT,
    "syncTags" TEXT NOT NULL DEFAULT 'shopify-sync',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "SyncedAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "bynderAssetId" TEXT NOT NULL,
    "shopifyFileId" TEXT NOT NULL,
    "syncType" TEXT NOT NULL,
    "bynderTags" TEXT,
    "bynderVersion" INTEGER,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SyncedAsset_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "bynderWebhookId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookSubscription_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "assetsProcessed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shop_key" ON "Shop"("shop");

-- CreateIndex
CREATE INDEX "SyncedAsset_shopId_idx" ON "SyncedAsset"("shopId");

-- CreateIndex
CREATE INDEX "SyncedAsset_bynderAssetId_idx" ON "SyncedAsset"("bynderAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncedAsset_shopId_bynderAssetId_key" ON "SyncedAsset"("shopId", "bynderAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookSubscription_shopId_bynderWebhookId_key" ON "WebhookSubscription"("shopId", "bynderWebhookId");

-- CreateIndex
CREATE INDEX "SyncJob_shopId_status_idx" ON "SyncJob"("shopId", "status");
