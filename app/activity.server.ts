import db from "./db.server";
import {
  listExecutions as listExecutionsCore,
  listExecutionRows as listExecutionRowsCore,
  getExecutionDetail as getExecutionDetailCore,
  awaitingConfirmationCount as awaitingConfirmationCountCore,
  countExecutions as countExecutionsCore,
  countsByStatusSince as countsByStatusSinceCore,
  type ListFilters,
} from "./lib/activity";

/** Activity Logs 面的真实库绑定；逻辑在 lib/activity，便于脱库单测。 */
export const activityService = {
  list: (shopId: string, filters: ListFilters = {}) =>
    listExecutionsCore(db, shopId, filters),
  listRows: (shopId: string, filters: ListFilters = {}) =>
    listExecutionRowsCore(db, shopId, filters),
  detail: (shopId: string, executionId: string) =>
    getExecutionDetailCore(db, shopId, executionId),
  awaitingCount: (shopId: string) => awaitingConfirmationCountCore(db, shopId),
  /** V2.0 Dashboard KPI：ExecutionLog 累计计数（不排状态）。 */
  count: (shopId: string, opts?: { since?: Date }) =>
    countExecutionsCore(db, shopId, opts ?? {}),
  /** V2.0 Dashboard KPI：时间窗口内按状态分组的原始计数（无样本时字段缺省即视为 0）。 */
  countsByStatus: (shopId: string, since: Date) =>
    countsByStatusSinceCore(db, shopId, since),
};
