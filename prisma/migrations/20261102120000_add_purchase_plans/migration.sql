-- Purchase Plans MVP：计划头 + 计划行（从 accepted/edited 建议按供应商归并生成）
-- CreateTable
CREATE TABLE "PurchasePlan" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "supplierId" TEXT,
    "supplierName" TEXT,
    "locationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "purchaseDate" TEXT,
    "notes" TEXT,
    "orderedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchasePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchasePlanLine" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitCost" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchasePlanLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchasePlan_shop_reference_key" ON "PurchasePlan"("shop", "reference");

-- CreateIndex
CREATE INDEX "PurchasePlan_shop_status_idx" ON "PurchasePlan"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchasePlanLine_planId_variantId_key" ON "PurchasePlanLine"("planId", "variantId");

-- CreateIndex
CREATE INDEX "PurchasePlanLine_shop_planId_idx" ON "PurchasePlanLine"("shop", "planId");

-- AddForeignKey
ALTER TABLE "PurchasePlanLine" ADD CONSTRAINT "PurchasePlanLine_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PurchasePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
