/**
 * Onboarding 推导：把「安装 → 第一条可信建议」路径上缺什么，从已有数据状态
 * 推成一张有序清单。纯函数、无库访问，Home 与单测共用同一判定。
 */

export type OnboardingInput = {
  /** 是否已选定库存地点（settings.locationId）。 */
  locationChosen: boolean;
  /** 是否完成过至少一次库存同步。 */
  synced: boolean;
  /** 商家是否保存过补货参数（区别于 schema 默认值）。 */
  paramsSaved: boolean;
  /** 当前建议行数（同步登记出的待表态 + 已表态）。 */
  adviceCount: number;
  /** 已表态（accepted / edited / ordered）的行数。 */
  decidedCount: number;
};

export type OnboardingStep = {
  key: "location" | "sync" | "params" | "advice" | "decision";
  title: string;
  hint: string;
  href: string;
  cta: string;
  done: boolean;
};

/**
 * 步骤按依赖顺序排列，只有前一步完成才可能推进到下一步；
 * 「确认参数」允许跳过（默认值也能出建议），所以它不作为完成的阻断项。
 */
export function deriveOnboardingSteps(
  input: OnboardingInput,
): OnboardingStep[] {
  return [
    {
      key: "location",
      title: "Choose your inventory location",
      hint: "Stock coverage is measured at one Shopify location; sales cover the whole store.",
      href: "/app/inventory",
      cta: "Pick location",
      done: input.locationChosen,
    },
    {
      key: "sync",
      title: "Run your first sync",
      hint: "Sync reads products, inventory and paid orders. It never changes your store.",
      href: "/app/inventory",
      cta: "Sync now",
      done: input.synced,
    },
    {
      key: "params",
      title: "Confirm replenishment parameters",
      hint: "Lead time, review cycle and safety stock start as system estimates — save your own numbers when you know them.",
      href: "/app/settings",
      cta: "Review parameters",
      done: input.paramsSaved,
    },
    {
      key: "advice",
      title: "Get your first reorder advice",
      hint: "After a successful sync, variants below their reorder point show up with an explained suggested quantity.",
      href: "/app/inventory",
      cta: "View advice",
      done: input.adviceCount > 0,
    },
    {
      key: "decision",
      title: "Make your first decision",
      hint: "Accept, adjust or ignore one suggestion — that's the moment the app starts learning what you actually order.",
      href: "/app/inventory",
      cta: "Decide",
      done: input.decidedCount > 0,
    },
  ];
}

/** 全部步骤完成才收起引导卡；「第一条可信建议」是主线，第一次决策是收尾。 */
export function isOnboardingComplete(input: OnboardingInput): boolean {
  return deriveOnboardingSteps(input).every((step) => step.done);
}

/** 当前应该展示的下一步（第一个未完成的步骤）。 */
export function nextOnboardingStep(
  input: OnboardingInput,
): OnboardingStep | null {
  return deriveOnboardingSteps(input).find((step) => !step.done) ?? null;
}
