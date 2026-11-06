// 带扩展名是故意的：本文件要能被 `node --test` 直接加载。
// 集成密钥加解密原语：AES-256-GCM。密钥来自 env AUTOMATION_SECRET_KEY（32 字节 hex），
// 明文密钥永不入库/日志。为可测试，允许把密钥作为参数注入（引擎/路由用 env 默认）。
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** 解析并校验 32 字节密钥；缺失或长度不对都给可读错误，不静默降级成弱加密。 */
function keyBytes(keyHex?: string): Buffer {
  const raw = keyHex ?? process.env.AUTOMATION_SECRET_KEY ?? "";
  if (!raw)
    throw new Error(
      "AUTOMATION_SECRET_KEY is not set; cannot protect integration secrets.",
    );
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32)
    throw new Error("AUTOMATION_SECRET_KEY must be 64 hex characters (32 bytes).");
  return key;
}

/** 加密成 `iv.tag.ciphertext`（均 base64）；每次随机 IV，同明文不同密文。 */
export function encryptSecret(plaintext: string, keyHex?: string): string {
  const key = keyBytes(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString("base64")).join(".");
}

/** 解密；格式错误或密文被篡改（GCM 认证失败）都抛可读错误。 */
export function decryptSecret(payload: string, keyHex?: string): string {
  const key = keyBytes(keyHex);
  const parts = payload.split(".");
  if (parts.length !== 3)
    throw new Error("Invalid encrypted secret format.");
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** 供启动自检：密钥是否可用（不抛错版本）。 */
export function isSecretConfigured(keyHex?: string): boolean {
  try {
    keyBytes(keyHex);
    return true;
  } catch {
    return false;
  }
}
