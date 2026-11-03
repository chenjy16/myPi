import { z } from "zod";
import { createLogger } from "./lib/logger.ts";

export const MODEL_REQUEST_TIMEOUT_MS = 90_000;

const MODEL_CONFIG_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** 模型必须返回且仅返回 title、description 两个字段。 */
export const productCopySchema = z
  .object({
    title: z.string().trim().min(1).max(255),
    description: z.string().trim().min(1).max(20_000),
  })
  .strict();

export type ProductCopySuggestion = z.infer<typeof productCopySchema>;

export type ProductCopyErrorCode =
  | "configuration"
  | "missing_api_key"
  | "model_not_found"
  | "timeout"
  | "rate_limited"
  | "authentication"
  | "invalid_output"
  | "provider";

const ERROR_MESSAGES: Record<ProductCopyErrorCode, string> = {
  configuration:
    "The model service isn't configured or the configuration is invalid. Please check the server-side model environment variables.",
  missing_api_key:
    "The model service has no API Key set. Please set PI_API_KEY in the server environment variables.",
  model_not_found:
    "The current PI_PROVIDER / PI_MODEL isn't supported by the Pi SDK. Please check the server configuration.",
  timeout:
    "The model request didn't complete within 90 seconds. Please try again later.",
  rate_limited:
    "The model service is receiving too many requests. Please try again later.",
  authentication:
    "Model service authentication failed. Please check the server-side PI_API_KEY.",
  invalid_output:
    "The copy returned by the model is invalid in format or exceeds field length limits. Please retry.",
  provider:
    "The model service call failed. Please check the network, model status, or configuration and try again.",
};

/** 文案/模型调用的分类错误，message 可直接展示给商家。 */
export class ProductCopyError extends Error {
  constructor(readonly code: ProductCopyErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ProductCopyError";
  }
}

export type ModelConfiguration = {
  provider: string;
  model: string;
  apiKey: string | undefined;
};

/** 从环境变量读取 Provider/Model/API Key；格式非法则抛 configuration。 */
export function getModelConfiguration(
  env: Record<string, string | undefined> = process.env,
): ModelConfiguration {
  const provider = env.PI_PROVIDER?.trim() || "openai";
  const model = env.PI_MODEL?.trim() || "gpt-4.1-mini";
  if (!MODEL_CONFIG_VALUE.test(provider) || !MODEL_CONFIG_VALUE.test(model)) {
    throw new ProductCopyError("configuration");
  }

  return {
    provider,
    model,
    apiKey: env.PI_API_KEY?.trim() || undefined,
  };
}

/** 给设置页用的安全状态：不含 API Key，只含是否已配置、配置是否合法。 */
export function getModelConfigurationStatus(): Omit<
  ModelConfiguration,
  "apiKey"
> & { configured: boolean; valid: boolean } {
  try {
    const { provider, model, apiKey } = getModelConfiguration();
    return { provider, model, configured: Boolean(apiKey), valid: true };
  } catch {
    return {
      provider: "invalid",
      model: "invalid",
      configured: Boolean(process.env.PI_API_KEY?.trim()),
      valid: false,
    };
  }
}

/** 调用模型前必须有 API Key，否则抛 missing_api_key。 */
export function requireModelApiKey(configuration: ModelConfiguration): string {
  if (!configuration.apiKey) {
    throw new ProductCopyError("missing_api_key");
  }
  return configuration.apiKey;
}

/** 解析模型回复为严格 JSON（可去掉 markdown 围栏），并用 Zod 校验标题/描述长度。 */
export function parseProductCopyResponse(text: string): ProductCopySuggestion {
  const json = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ProductCopyError("invalid_output");
  }

  const result = productCopySchema.safeParse(value);
  if (!result.success) {
    throw new ProductCopyError("invalid_output");
  }
  return result.data;
}

/** 沿 error.cause 链收集 name/code/message/status，供错误分类使用。 */
function getErrorDetails(error: unknown): {
  name: string;
  code: string;
  message: string;
  status: number | undefined;
} {
  const seen = new Set<object>();
  const details = {
    name: "",
    code: "",
    message: "",
    status: undefined as number | undefined,
  };
  let current: unknown = error;

  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth += 1
  ) {
    if (seen.has(current)) break;
    seen.add(current);

    const record = current as Record<string, unknown>;
    if (!details.name && typeof record.name === "string") {
      details.name = record.name;
    }
    if (!details.code && typeof record.code === "string") {
      details.code = record.code;
    }
    if (!details.message && typeof record.message === "string") {
      details.message = record.message;
    }
    const status = record.status ?? record.statusCode;
    if (!details.status && typeof status === "number") {
      details.status = status;
    }
    current = record.cause;
  }

  if (typeof error === "string") details.message = error;
  return details;
}

/** 把 Provider/SDK 抛出的异常归一成 ProductCopyError，避免把原始细节暴露给 UI。 */
export function normalizeModelError(error: unknown): ProductCopyError {
  if (error instanceof ProductCopyError) return error;

  const details = getErrorDetails(error);
  const signal =
    `${details.name} ${details.code} ${details.message}`.toLowerCase();

  if (
    details.status === 401 ||
    details.status === 403 ||
    /invalid api key|unauthorized|authentication failed/.test(signal)
  ) {
    return new ProductCopyError("authentication");
  }
  if (
    details.status === 429 ||
    /rate.?limit|too many requests|resource_exhausted/.test(signal)
  ) {
    return new ProductCopyError("rate_limited");
  }
  if (/time.?out|timed out|etimedout|aborterror|aborted/.test(signal)) {
    return new ProductCopyError("timeout");
  }
  return new ProductCopyError("provider");
}

/** 给模型请求加超时；超时后调用 onTimeout（通常 abort session）再抛 timeout。 */
export async function withModelTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new ProductCopyError("timeout"));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (!timedOut) throw error;

    try {
      await onTimeout();
    } catch (abortError) {
      const { name } = getErrorDetails(abortError);
      createLogger().error("failed to abort timed-out Pi request", { name });
    }
    throw new ProductCopyError("timeout");
  } finally {
    if (timer) clearTimeout(timer);
  }
}
