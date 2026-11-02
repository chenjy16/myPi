-- 修复迁移与 schema 的漂移：Location 缺少 @updatedAt 对应的列。
-- 用 DEFAULT + DROP DEFAULT 两步，保证在已有数据的库上也能安全执行。

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Location" ALTER COLUMN     "updatedAt" DROP DEFAULT;
