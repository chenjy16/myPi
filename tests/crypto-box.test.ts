import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decryptSecret,
  encryptSecret,
  isSecretConfigured,
} from "../app/lib/crypto-box.ts";

/**
 * AES-256-GCM 加解密原语单测（P1-16）：密钥经参数注入，不依赖 env，
 * 覆盖往返、IV 随机性、篡改检测、格式错误、密钥缺失/长度非法的可读报错。
 */

const KEY_HEX = "4a5b".repeat(16); // 64 个 hex 字符 = 32 字节，仅存在于测试进程内存
const OTHER_KEY_HEX = "b7c3".repeat(16);

test("加密→解密往返一致", () => {
  const plaintext = "shpat_live_super-secret_123";
  const sealed = encryptSecret(plaintext, KEY_HEX);
  assert.equal(decryptSecret(sealed, KEY_HEX), plaintext);
});

test("密文形状为 iv.tag.ciphertext 三段 base64，且不含明文", () => {
  const sealed = encryptSecret("topsecret", KEY_HEX);
  const parts = sealed.split(".");
  assert.equal(parts.length, 3);
  for (const part of parts) {
    assert.ok(part.length > 0 && !part.includes("topsecret"));
  }
});

test("同明文两次加密密文不同（IV 每次随机）", () => {
  const a = encryptSecret("same-input", KEY_HEX);
  const b = encryptSecret("same-input", KEY_HEX);
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a, KEY_HEX), "same-input");
  assert.equal(decryptSecret(b, KEY_HEX), "same-input");
});

test("密文被篡改：GCM 认证失败抛错，绝不返回脏数据", () => {
  const sealed = encryptSecret("integrity-matters", KEY_HEX);
  const [iv, tag, data] = sealed.split(".");
  const tampered = `${iv}.${tag}.${Buffer.from(
    Buffer.from(data, "base64").map((byte) => byte ^ 0xff),
  ).toString("base64")}`;
  assert.throws(() => decryptSecret(tampered, KEY_HEX));
});

test("换密钥解密失败，密钥不匹配无从偷读他店密文", () => {
  const sealed = encryptSecret("cross-key", KEY_HEX);
  assert.throws(() => decryptSecret(sealed, OTHER_KEY_HEX));
});

test("格式错误（段数不足）给可读错误", () => {
  assert.throws(() => decryptSecret("not-a-sealed-secret", KEY_HEX), {
    message: /Invalid encrypted secret format/,
  });
});

test("密钥缺失/长度非法：报可读错误，绝不静默降级成弱加密", () => {
  const original = process.env.AUTOMATION_SECRET_KEY;
  try {
    delete process.env.AUTOMATION_SECRET_KEY;
    assert.throws(() => encryptSecret("x"), {
      message: /AUTOMATION_SECRET_KEY is not set/,
    });
    assert.throws(() => encryptSecret("x", "abcd"), {
      message: /64 hex characters/,
    });
    assert.equal(isSecretConfigured(), false);
    assert.equal(isSecretConfigured(KEY_HEX), true);
  } finally {
    if (original === undefined) delete process.env.AUTOMATION_SECRET_KEY;
    else process.env.AUTOMATION_SECRET_KEY = original;
  }
});
