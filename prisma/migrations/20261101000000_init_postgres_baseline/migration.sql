-- Prisma baseline migration for the PostgreSQL datasource.
-- Generated offline via:
--   npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
-- The previous six SQLite migrations were retired when the project switched to PostgreSQL.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductDraft" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "originalTitle" TEXT NOT NULL,
    "originalDescriptionHtml" TEXT NOT NULL,
    "suggestedTitle" TEXT NOT NULL,
    "suggestedDescription" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "ProductDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventorySettings" (
    "shop" TEXT NOT NULL,
    "locationId" TEXT,
    "locationName" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "leadTimeDays" INTEGER NOT NULL DEFAULT 14,
    "safetyStockDays" INTEGER NOT NULL DEFAULT 7,
    "reviewPeriodDays" INTEGER NOT NULL DEFAULT 14,
    "lastInventorySyncAt" TIMESTAMP(3),
    "lastSalesSyncAt" TIMESTAMP(3),
    "salesHistoryComplete" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventorySettings_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "InventorySnapshot" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "sku" TEXT,
    "tracked" BOOLEAN NOT NULL,
    "available" INTEGER NOT NULL DEFAULT 0,
    "incoming" INTEGER NOT NULL DEFAULT 0,
    "unitCost" DOUBLE PRECISION,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventorySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDaily" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "SalesDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReorderRecommendation" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "suggestedQuantity" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReorderRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductDraft_shop_createdAt_idx" ON "ProductDraft"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductDraft_shop_requestId_key" ON "ProductDraft"("shop", "requestId");

-- CreateIndex
CREATE INDEX "InventorySnapshot_shop_locationId_tracked_idx" ON "InventorySnapshot"("shop", "locationId", "tracked");

-- CreateIndex
CREATE UNIQUE INDEX "InventorySnapshot_shop_locationId_variantId_key" ON "InventorySnapshot"("shop", "locationId", "variantId");

-- CreateIndex
CREATE INDEX "SalesDaily_shop_date_idx" ON "SalesDaily"("shop", "date");

-- CreateIndex
CREATE UNIQUE INDEX "SalesDaily_shop_variantId_date_key" ON "SalesDaily"("shop", "variantId", "date");

-- CreateIndex
CREATE INDEX "ReorderRecommendation_shop_locationId_status_idx" ON "ReorderRecommendation"("shop", "locationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReorderRecommendation_shop_locationId_variantId_key" ON "ReorderRecommendation"("shop", "locationId", "variantId");
