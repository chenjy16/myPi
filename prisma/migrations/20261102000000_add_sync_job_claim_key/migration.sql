-- 阶段 1（P0-3）：给同步任务加跨进程锁。
-- running 行占用 "shop:jobType" 这个唯一键，任务结束（成功/失败/租约过期）时释放，
-- 于是双击 Sync、cron 与 webhook 同时触发时只会有一个真正执行。

-- AlterTable
ALTER TABLE "DataSyncJob" ADD COLUMN     "activeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "DataSyncJob_activeKey_key" ON "DataSyncJob"("activeKey");

-- 加锁之前遗留的 running 行没有锁语义，一律判为已死：
-- 它们只可能来自已经退出的进程，留在台账里会持续误导「同步进行中」。
UPDATE "DataSyncJob"
SET
    "status" = 'failed',
    "finishedAt" = now(),
    "error" = 'Marked failed when the sync job lock was introduced; the process that started it had already stopped.'
WHERE
    "status" = 'running';
