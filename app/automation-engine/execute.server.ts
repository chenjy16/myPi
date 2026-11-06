// 引擎编排的真实库绑定面（P2-11）：逻辑全在 lib/automation-engine，本文件只注入 Prisma。
import db from "../db.server";
import {
  runAutomation as runCore,
  type AutomationRunOutcome,
  type EngineDeps,
  type RunInput,
} from "../lib/automation-engine.ts";

/** 执行一条已匹配的自动化；写/出站依赖（admin/email/webhook/loopGuard）由调用方注入。 */
export function executeAutomation(
  input: RunInput,
  binding: Omit<EngineDeps, "client">,
): Promise<AutomationRunOutcome> {
  return runCore({ ...binding, client: db }, input);
}

export type { AutomationRunOutcome, EngineDeps, RunInput } from "../lib/automation-engine.ts";
