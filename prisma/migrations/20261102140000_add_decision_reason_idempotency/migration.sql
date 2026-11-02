-- Stage 7 前置：决策理由 + 请求级幂等（P1-5 / 缺陷 #12）
-- AlterTable
ALTER TABLE "ReorderRecommendation" ADD COLUMN IF NOT EXISTS "decisionReason" TEXT;

-- AlterTable
ALTER TABLE "RecommendationAudit" ADD COLUMN IF NOT EXISTS "reason" TEXT;
ALTER TABLE "RecommendationAudit" ADD COLUMN IF NOT EXISTS "requestKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RecommendationAudit_requestKey_key" ON "RecommendationAudit"("requestKey");
