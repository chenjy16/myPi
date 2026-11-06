import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { createLogger } from "../lib/logger";

const logger = createLogger({ component: "webhook.scopes-update" });

/** 权限变更：把 session.scope 更新为 webhook payload 中的最新 scopes。 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);
  logger.info(`Received ${topic} webhook`, { shop });

  const current = payload.current as string[];
  if (session) {
    await db.session.update({
      where: {
        id: session.id,
      },
      data: {
        scope: current.toString(),
      },
    });
  }
  return new Response();
};
