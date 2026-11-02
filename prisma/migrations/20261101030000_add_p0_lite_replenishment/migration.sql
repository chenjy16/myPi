-- 阶段 2（P0-lite）：补货建议要带置信度与 Observed Demand 口径，决策动作要留审计流水。

-- AlterTable: 记录当前授权下可见的历史起点，用于算样本天数与覆盖率
ALTER TABLE "InventorySettings" ADD COLUMN     "salesWindowStart" TEXT;

-- AlterTable: 建议行补上置信度档位与 Observed Demand 摘要
ALTER TABLE "ReorderRecommendation" ADD COLUMN     "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "confidence" TEXT NOT NULL DEFAULT 'medium',
ADD COLUMN     "demandPerDay" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "demandSampleDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "demandWindowDays" INTEGER NOT NULL DEFAULT 30;

-- CreateTable: 补货决策审计流水，append-only
CREATE TABLE "RecommendationAudit" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "suggestedQuantity" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "confidence" TEXT,
    "operator" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecommendationAudit_shop_locationId_variantId_createdAt_idx" ON "RecommendationAudit"("shop", "locationId", "variantId", "createdAt");

-- CreateIndex
CREATE INDEX "RecommendationAudit_shop_action_createdAt_idx" ON "RecommendationAudit"("shop", "action", "createdAt");
