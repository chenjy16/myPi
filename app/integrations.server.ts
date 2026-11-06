import db from "./db.server";
import {
  listIntegrations as listIntegrationsCore,
  createIntegration as createIntegrationCore,
  deleteIntegration as deleteIntegrationCore,
  testIntegration as testIntegrationCore,
  type CreateIntegrationInput,
  type IntegrationKind,
  type TestIntegrationDeps,
} from "./lib/integrations-core";

/**
 * Integrations 面的真实库绑定；逻辑在 lib/integrations-core，便于脱库单测。
 * 测试连接的 provider（邮件发送器 / webhook fetch）由调用方按运行时注入，
 * 未接线时 testIntegration 依诚实边界返回 failing，绝不伪造 healthy。
 */
export const integrationsService = {
  list: (shopId: string, kind?: IntegrationKind) =>
    listIntegrationsCore(db, shopId, kind),
  create: (shopId: string, input: CreateIntegrationInput) =>
    createIntegrationCore(db, shopId, input),
  remove: (shopId: string, id: string) => deleteIntegrationCore(db, shopId, id),
  test: (shopId: string, id: string, deps?: TestIntegrationDeps) =>
    testIntegrationCore(db, shopId, id, deps),
};
