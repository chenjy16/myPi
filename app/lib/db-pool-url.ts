/**
 * 数据库连接池参数的纯算术层（P0-3）。
 * 单独成文件、且只依赖 URL 标准库，是为了能在不构造 PrismaClient、不连库的情况下被单测覆盖。
 *
 * 连接方式以 .env.example 确立的口径为准：Supabase 的 **Session pooler（IPv4）**，
 * 每个 Prisma 连接对应一个专用后端，因此 `connection_limit` 直接决定这个进程占用多少后端。
 * Web 与 Worker 是两条独立进程、各自一份池，预算分别用各自的环境变量给。
 *
 * 只写 Prisma 6 的 postgres 驱动确实支持的连接串参数（connection_limit / pool_timeout / connect_timeout）。
 * 刻意不往 URL 里塞 statement_timeout——那不是 Prisma 连接串参数，属于 Postgres/Supabase 服务端设置，
 * 塞进去会导致连接失败（计划红线：不写不适用当前版本的参数）。
 */

const DEFAULT_CONNECTION_LIMIT = 10;
const DEFAULT_POOL_TIMEOUT_SECONDS = 10;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 20;
const MAX_CONNECTION_LIMIT = 100;

export type PoolSettings = {
  connectionLimit: number;
  /** 从池里取一个连接的等待上限（秒）。 */
  poolTimeoutSeconds: number;
  /** 建立单条连接的上限（秒）；跨区冷连接常超过 Prisma 默认 5s。 */
  connectTimeoutSeconds: number;
};

type EnvRecord = Record<string, string | undefined>;

/** 取正整数；缺失/非数字/<=0 回落到默认，上限封顶避免配错打爆数据库连接预算。 */
function positiveInt(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

/** 从环境解析池预算；每个键都可单独覆盖，非法值安全回落。 */
export function resolvePoolSettings(env: EnvRecord = process.env): PoolSettings {
  return {
    connectionLimit: positiveInt(
      env.DB_CONNECTION_LIMIT,
      DEFAULT_CONNECTION_LIMIT,
      MAX_CONNECTION_LIMIT,
    ),
    poolTimeoutSeconds: positiveInt(
      env.DB_POOL_TIMEOUT_SECONDS,
      DEFAULT_POOL_TIMEOUT_SECONDS,
      120,
    ),
    connectTimeoutSeconds: positiveInt(
      env.DB_CONNECT_TIMEOUT_SECONDS,
      DEFAULT_CONNECT_TIMEOUT_SECONDS,
      120,
    ),
  };
}

/**
 * 把池参数补进 DATABASE_URL 的查询串，返回给 PrismaClient 用的最终连接串。
 * 只补「缺失」的参数，绝不覆盖运维已经写在连接串里的显式值（尊重 .env 的既有意图）。
 * DATABASE_URL 缺失时返回 undefined，让上层回落到默认构造（Prisma 自己读 env），
 * 而不是拿一个空串去 new PrismaClient 触发解析错误。
 */
export function buildDatasourceUrl(
  env: EnvRecord = process.env,
  settings: PoolSettings = resolvePoolSettings(env),
): string | undefined {
  const raw = env.DATABASE_URL;
  if (!raw) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // 连接串形状异常时不猜测、不篡改，原样交回，让 Prisma 给出它自己的报错。
    return raw;
  }

  const poolParams: Record<string, string> = {
    connection_limit: String(settings.connectionLimit),
    pool_timeout: String(settings.poolTimeoutSeconds),
    connect_timeout: String(settings.connectTimeoutSeconds),
  };
  for (const [key, value] of Object.entries(poolParams)) {
    if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  }
  return url.toString();
}
