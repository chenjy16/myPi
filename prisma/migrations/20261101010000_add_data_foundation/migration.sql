-- Data foundation for P0-lite: multi-location model, daily inventory snapshot
-- time series, inventory event stream and background sync job ledger.
-- Generated via:
--   npx prisma migrate diff --from-url "$DATABASE_URL" \
--     --to-schema-datamodel prisma/schema.prisma --script

-- DropIndex
DROP INDEX "InventorySnapshot_shop_locationId_tracked_idx";

-- DropIndex
DROP INDEX "InventorySnapshot_shop_locationId_variantId_key";

-- AlterTable
ALTER TABLE "InventorySnapshot" ADD COLUMN     "onHand" INTEGER,
ADD COLUMN     "snapshotDate" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyLocationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "locationId" TEXT,
    "variantId" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "delta" INTEGER,
    "availableAfter" INTEGER,
    "source" TEXT NOT NULL,
    "externalId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSyncJob" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "triggeredBy" TEXT NOT NULL DEFAULT 'manual',
    "cursor" TEXT,
    "recordsProcessed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataSyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Location_shop_isActive_idx" ON "Location"("shop", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Location_shop_shopifyLocationId_key" ON "Location"("shop", "shopifyLocationId");

-- CreateIndex
CREATE INDEX "InventoryEvent_shop_variantId_occurredAt_idx" ON "InventoryEvent"("shop", "variantId", "occurredAt");

-- CreateIndex
CREATE INDEX "InventoryEvent_shop_occurredAt_idx" ON "InventoryEvent"("shop", "occurredAt");

-- CreateIndex
CREATE INDEX "InventoryEvent_shop_source_externalId_idx" ON "InventoryEvent"("shop", "source", "externalId");

-- CreateIndex
CREATE INDEX "DataSyncJob_shop_jobType_status_idx" ON "DataSyncJob"("shop", "jobType", "status");

-- CreateIndex
CREATE INDEX "DataSyncJob_shop_startedAt_idx" ON "DataSyncJob"("shop", "startedAt");

-- CreateIndex
CREATE INDEX "InventorySnapshot_shop_locationId_snapshotDate_tracked_idx" ON "InventorySnapshot"("shop", "locationId", "snapshotDate", "tracked");

-- CreateIndex
CREATE INDEX "InventorySnapshot_shop_variantId_snapshotDate_idx" ON "InventorySnapshot"("shop", "variantId", "snapshotDate");

-- CreateIndex
CREATE UNIQUE INDEX "InventorySnapshot_shop_locationId_variantId_snapshotDate_key" ON "InventorySnapshot"("shop", "locationId", "variantId", "snapshotDate");
