import db from "./db.server";
import {
  listAutomations as listAutomationsCore,
  getAutomation as getAutomationCore,
  createFromTemplate as createFromTemplateCore,
  updateParams as updateParamsCore,
  setActive as setActiveCore,
  pause as pauseCore,
  softDelete as softDeleteCore,
  type CreateFromTemplateInput,
} from "./lib/automations-core";

/** 自动化管理面的真实库绑定；逻辑在 lib/automations-core，便于脱库单测。 */
export const automationsService = {
  list: (shopId: string) => listAutomationsCore(db, shopId),
  get: (shopId: string, id: string) => getAutomationCore(db, shopId, id),
  createFromTemplate: (shopId: string, input: CreateFromTemplateInput) =>
    createFromTemplateCore(db, shopId, input),
  updateParams: (shopId: string, id: string, params: Record<string, unknown>) =>
    updateParamsCore(db, shopId, id, params),
  setActive: (shopId: string, id: string) => setActiveCore(db, shopId, id),
  pause: (shopId: string, id: string) => pauseCore(db, shopId, id),
  softDelete: (shopId: string, id: string) => softDeleteCore(db, shopId, id),
};
