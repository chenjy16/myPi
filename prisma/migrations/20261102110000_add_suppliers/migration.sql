-- Suppliers MVP：供应商档案 + 变体级供货绑定（MOQ / case pack / 供应商级交期）
-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "leadTimeDays" INTEGER,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantSupplier" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "minOrderQuantity" INTEGER NOT NULL DEFAULT 0,
    "casePack" INTEGER NOT NULL DEFAULT 0,
    "unitCost" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantSupplier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_shop_name_key" ON "Supplier"("shop", "name");

-- CreateIndex
CREATE INDEX "Supplier_shop_isActive_idx" ON "Supplier"("shop", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "VariantSupplier_shop_variantId_key" ON "VariantSupplier"("shop", "variantId");

-- CreateIndex
CREATE INDEX "VariantSupplier_shop_supplierId_idx" ON "VariantSupplier"("shop", "supplierId");

-- AddForeignKey
ALTER TABLE "VariantSupplier" ADD CONSTRAINT "VariantSupplier_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
