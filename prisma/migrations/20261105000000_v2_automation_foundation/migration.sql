-- V2.0 Automation Toolkit 基础设施（additive）：新增 8 表 Shop/Automation/
-- AutomationVersion/WebhookDelivery/ExecutionLog/ExecutionStep/Integration/ScheduledJob。
-- 仅 CREATE + 对新表加索引/外键；不改动任何 V1 旧表（可回滚：DROP 新表即可）。
-- 基准 docs/PRD-V2.0.md §27 / docs/V2-PHASE1-TASKS.md P1-02。

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "primaryCountry" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Automation" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'paused',
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationVersion" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "templateId" TEXT,
    "templateVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "shop" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "automationVersion" INTEGER NOT NULL,
    "triggerType" TEXT NOT NULL,
    "entityRef" TEXT,
    "dedupeKey" TEXT,
    "status" TEXT NOT NULL,
    "cascadeDepth" INTEGER NOT NULL DEFAULT 0,
    "conditionResult" JSONB,
    "payload" JSONB,
    "parentExecutionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionStep" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "actionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "errorText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "config" JSONB NOT NULL,
    "secretsEncrypted" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledJob" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "cadence" TEXT NOT NULL,
    "dailyTime" TEXT,
    "timezone" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "activeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shop_key" ON "Shop"("shop");

-- CreateIndex
CREATE INDEX "Automation_shopId_status_idx" ON "Automation"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationVersion_automationId_version_key" ON "AutomationVersion"("automationId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_webhookId_key" ON "WebhookDelivery"("webhookId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_receivedAt_idx" ON "WebhookDelivery"("receivedAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_shop_topic_receivedAt_idx" ON "WebhookDelivery"("shop", "topic", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionLog_dedupeKey_key" ON "ExecutionLog"("dedupeKey");

-- CreateIndex
CREATE INDEX "ExecutionLog_shopId_automationId_createdAt_idx" ON "ExecutionLog"("shopId", "automationId", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionLog_shopId_status_createdAt_idx" ON "ExecutionLog"("shopId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionLog_shopId_entityRef_idx" ON "ExecutionLog"("shopId", "entityRef");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionStep_executionId_order_key" ON "ExecutionStep"("executionId", "order");

-- CreateIndex
CREATE INDEX "Integration_shopId_kind_idx" ON "Integration"("shopId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledJob_activeKey_key" ON "ScheduledJob"("activeKey");

-- CreateIndex
CREATE INDEX "ScheduledJob_shopId_nextRunAt_idx" ON "ScheduledJob"("shopId", "nextRunAt");

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationVersion" ADD CONSTRAINT "AutomationVersion_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionLog" ADD CONSTRAINT "ExecutionLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionLog" ADD CONSTRAINT "ExecutionLog_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionLog" ADD CONSTRAINT "ExecutionLog_parentExecutionId_fkey" FOREIGN KEY ("parentExecutionId") REFERENCES "ExecutionLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionStep" ADD CONSTRAINT "ExecutionStep_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ExecutionLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledJob" ADD CONSTRAINT "ScheduledJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

