-- 补货参数来源标注：区分「商家保存过的设置」与「schema 默认的系统估计」
-- AlterTable
ALTER TABLE "InventorySettings" ADD COLUMN     "replenishmentSettingsSavedAt" TIMESTAMP(3);
