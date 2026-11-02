-- Stage 5：产品埋点事件 + 建议反馈
-- CreateTable
CREATE TABLE "AnalyticsEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "props" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdviceFeedback" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "reason" TEXT,
    "comment" TEXT,
    "auditId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdviceFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalyticsEvent_shop_type_createdAt_idx" ON "AnalyticsEvent"("shop", "type", "createdAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_shop_createdAt_idx" ON "AnalyticsEvent"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "AdviceFeedback_shop_variantId_createdAt_idx" ON "AdviceFeedback"("shop", "variantId", "createdAt");

-- CreateIndex
CREATE INDEX "AdviceFeedback_shop_verdict_createdAt_idx" ON "AdviceFeedback"("shop", "verdict", "createdAt");
