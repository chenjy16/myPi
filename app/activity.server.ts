import db from "./db.server";
import {
  listExecutions as listExecutionsCore,
  listExecutionRows as listExecutionRowsCore,
  getExecutionDetail as getExecutionDetailCore,
  awaitingConfirmationCount as awaitingConfirmationCountCore,
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
};
