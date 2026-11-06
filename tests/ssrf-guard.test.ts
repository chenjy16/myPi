import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertResolvedAddresses,
  isBlockedAddress,
  validateOutboundUrl,
} from "../app/lib/ssrf-guard.ts";

test("URL 形状：只收 https 默认端口、无凭据、有主机名", () => {
  const ok = validateOutboundUrl("https://hooks.example.com/notify");
  assert.deepEqual(ok, { ok: true, hostname: "hooks.example.com", port: 443 });
  assert.equal(validateOutboundUrl("http://hooks.example.com").ok, false); // 明文拒
  assert.equal(validateOutboundUrl("https://hooks.example.com:8443/x").ok, false); // 非 443 拒
  assert.equal(validateOutboundUrl("https://user:pw@hooks.example.com").ok, false); // 凭据拒
  assert.equal(validateOutboundUrl("not a url").ok, false);
  assert.equal(validateOutboundUrl("https://").ok, false);
});

test("字面 IP 主机名在 URL 层即拦（不等解析）", () => {
  for (const raw of [
    "https://127.0.0.1/x",
    "https://10.0.0.8/x",
    "https://172.16.0.1/x",
    "https://192.168.1.1/x",
    "https://169.254.169.254/latest/meta-data/", // 云元数据经典靶
    "https://100.64.0.1/x", // CGNAT
    "https://0.0.0.0/x",
    "https://224.0.0.1/x", // 组播
    "https://[::1]/x",
    "https://[fe80::1]/x",
    "https://[fd00::10]/x", // ULA
  ])
    assert.equal(validateOutboundUrl(raw).ok, false, raw);
});

test("IPv4 保留段判定精确：合法公网段不误伤", () => {
  assert.equal(isBlockedAddress("8.8.8.8"), false);
  assert.equal(isBlockedAddress("172.15.0.1"), false); // 172.16/12 之外
  assert.equal(isBlockedAddress("172.31.255.255"), true);
  assert.equal(isBlockedAddress("192.0.1.1"), false); // 192.0.1/24 属 ARIN 公网
  assert.equal(isBlockedAddress("192.0.2.1"), true); // TEST-NET-1 文档段拦下
  assert.equal(isBlockedAddress("198.19.0.1"), true); // 198.18/15
  assert.equal(isBlockedAddress("198.20.0.1"), false);
  assert.equal(isBlockedAddress("example.com"), false); // 域名交由解析后判定
});

test("IPv6：环回/链路本地/ULA/组播全拦；v4-mapped 按 v4 规则复核", () => {
  assert.equal(isBlockedAddress("::"), true);
  assert.equal(isBlockedAddress("::1"), true);
  assert.equal(isBlockedAddress("fe80::abcd"), true);
  assert.equal(isBlockedAddress("fc00::1"), true);
  assert.equal(isBlockedAddress("fd12:3456::78"), true);
  assert.equal(isBlockedAddress("ff02::1"), true);
  assert.equal(isBlockedAddress("2606:4700:4700::1111"), false); // 公网 v6
  assert.equal(isBlockedAddress("::ffff:127.0.0.1"), true); // v4-mapped 环回
  assert.equal(isBlockedAddress("::ffff:8.8.8.8"), false);
  assert.equal(isBlockedAddress("[::1]"), true); // 方括号形态同样拦
});

test("解析结果整体判定：任一 IP 命中即拒、空解析拒", () => {
  assert.deepEqual(assertResolvedAddresses(["93.184.216.34"]), { ok: true });
  // 多 A 记录里藏一个内网地址是常见绕过——必须整批拒绝
  const sneaky = assertResolvedAddresses(["93.184.216.34", "127.0.0.1"]);
  assert.equal(sneaky.ok, false);
  assert.match(sneaky.reason ?? "", /private or reserved/);
  assert.equal(assertResolvedAddresses([]).ok, false);
});
