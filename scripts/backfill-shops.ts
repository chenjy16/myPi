/**
 * P1-05：Shop 租户一次性回填（迁移 §3.2）。
 *
 * 从既有 offline session 建 Shop 行——只读 session，绝不写回 accessToken/scopes，
 * 商家零重授权；backfillShops 本身幂等，可放心重复执行。
 * 运行方式与 worker 相同：esbuild 打包后用 node 跑（npm run backfill:shops），
 * 打包同时解决 app/*.server.ts 无扩展名导入在裸 node 下不可解析的问题。
 */
import db from "../app/db.server";
import { backfillShops } from "../app/lib/shop-directory";

async function main(): Promise<void> {
  const result = await backfillShops(db);
  console.log(
    `[backfill-shops] total=${result.total} created=${result.created} skipped=${result.skipped}`,
  );
}

main()
  .catch((error) => {
    console.error("[backfill-shops] failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void db.$disconnect();
  });
