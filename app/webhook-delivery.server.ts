import db from "./db.server";
import {
  tryRecordDelivery as tryRecordCore,
  pruneOldDeliveries as pruneCore,
  deliveryTtlCutoff,
  type DeliveryInput,
} from "./lib/webhook-delivery";

/** 投递去重的真实库绑定面；逻辑在 lib/webhook-delivery，便于脱库单测。 */
export function tryRecordDelivery(input: DeliveryInput) {
  return tryRecordCore(db, input);
}

/** 按 TTL 清理超期投递；不传 before 时用默认窗口（env 可配）。 */
export function pruneOldDeliveries(before: Date = deliveryTtlCutoff()) {
  return pruneCore(db, before);
}
