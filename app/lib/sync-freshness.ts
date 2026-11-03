/**
 * 同步新鲜度提示的文案层（纯函数，供 Home / Replenishment / Data Health 共用）。
 * 目标是 P0-2 红线：同步失败时绝不让旧快照看起来像刚刷新——必须同时说清
 * 「最近一次尝试失败了」+「正在展示上一次成功的数据」+ 那一次的真实时间。
 * 时间戳在页面侧用各自已有的格式化函数转好后传入，保持这里的可测与时区无关。
 */
import type { SyncStatus } from "./sync-job-policy.ts";

export type FreshnessTone = "ok" | "warn" | "critical" | "muted";

export type FreshnessNotice = {
  tone: FreshnessTone;
  /** 单行主文案，可直接渲染。 */
  message: string;
};

export type FreshnessLabels = {
  /** 已格式化的最近成功时间；无成功历史传 null。 */
  lastSuccessLabel: string | null;
};

export function buildSyncFreshnessNotice(
  status: SyncStatus,
  labels: FreshnessLabels,
): FreshnessNotice {
  switch (status.current) {
    case "never":
      return {
        tone: "muted",
        message:
          "No sync has run yet. Choose an inventory location and run a sync to load your data.",
      };
    case "running":
      return {
        tone: "muted",
        message:
          "Sync in progress. These numbers refresh automatically once it finishes.",
      };
    case "succeeded":
      return {
        tone: "ok",
        message: `Last successful sync: ${labels.lastSuccessLabel ?? "just now"}.`,
      };
    case "failed":
      // 有上一次成功数据可退路：明确告知在看旧数据 + 给出那次成功的时间。
      if (status.staleWithFallback) {
        return {
          tone: "warn",
          message: `Last sync failed${
            status.lastSyncError ? `: ${status.lastSyncError}` : ""
          }. Displaying data from the previous successful sync (${
            labels.lastSuccessLabel ?? "date unavailable"
          }).`,
        };
      }
      // 从未成功过：没有任何可信数据可展示。
      return {
        tone: "critical",
        message: `Last sync failed${
          status.lastSyncError ? `: ${status.lastSyncError}` : ""
        }. No verified data has loaded yet.`,
      };
  }
}
