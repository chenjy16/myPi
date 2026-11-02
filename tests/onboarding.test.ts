import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveOnboardingSteps,
  isOnboardingComplete,
  nextOnboardingStep,
  type OnboardingInput,
} from "../app/lib/onboarding.ts";

const FRESH: OnboardingInput = {
  locationChosen: false,
  synced: false,
  paramsSaved: false,
  adviceCount: 0,
  decidedCount: 0,
};

test("步骤顺序固定：地点 → 同步 → 参数 → 建议 → 决策", () => {
  assert.deepEqual(
    deriveOnboardingSteps(FRESH).map((step) => step.key),
    ["location", "sync", "params", "advice", "decision"],
  );
});

test("空店铺：未完成的是第一步，引导卡不收起", () => {
  assert.equal(isOnboardingComplete(FRESH), false);
  assert.equal(nextOnboardingStep(FRESH)?.key, "location");
});

test("参数没保存不算阻断：前三步里 params 可跳过", () => {
  const steps = deriveOnboardingSteps({
    ...FRESH,
    locationChosen: true,
    synced: true,
  });
  assert.equal(steps[0]?.done, true);
  assert.equal(steps[1]?.done, true);
  assert.equal(steps[2]?.done, false);
  assert.equal(nextOnboardingStep({ ...FRESH, locationChosen: true, synced: true })?.key, "params");
});

test("建议出现即算主线推进；决策完成才收起卡片", () => {
  const withAdvice: OnboardingInput = {
    locationChosen: true,
    synced: true,
    paramsSaved: true,
    adviceCount: 5,
    decidedCount: 0,
  };
  assert.equal(isOnboardingComplete(withAdvice), false);
  assert.equal(nextOnboardingStep(withAdvice)?.key, "decision");
  assert.equal(
    isOnboardingComplete({ ...withAdvice, decidedCount: 1 }),
    true,
  );
  assert.equal(nextOnboardingStep({ ...withAdvice, decidedCount: 1 }), null);
});

test("看板没建议时第 4 步未完成，即便行数为 0 也不谎报", () => {
  const steps = deriveOnboardingSteps({
    ...FRESH,
    locationChosen: true,
    synced: true,
    paramsSaved: true,
    adviceCount: 0,
  });
  assert.equal(steps[3]?.done, false);
});
