// 带扩展名是故意的：本文件要能被 `node --test` 直接加载（与同目录纯模块同一约定）。
// 纯逻辑：出站 webhook 的 SSRF 守卫清单（PRD §20 / OQ-9）。这里只做「形状 + IP 分类」的
// 确定性判定；DNS 解析与「解析后固定 IP 再连接」的 Rebinding 防护由调用方（P2-09 执行器）执行，
// 但每一批解析出的 IP 都必须回到本模块过一遍——地址判定只有这一份实现。
export type UrlVerdict =
  | { ok: true; hostname: string; port: number }
  | { ok: false; reason: string };

/** 仅放行 https 默认端口：非 443 一律拒，收窄元数据服务/内网旁路的暴露面（OQ-9）。 */
const ALLOWED_PORTS = new Set([443]);

function blocked(reason: string): UrlVerdict {
  return { ok: false, reason };
}

/** URL 形状校验：协议、凭据内嵌、端口白名单、主机名存在性。 */
export function validateOutboundUrl(raw: string): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return blocked("URL is not a valid absolute address.");
  }
  if (url.protocol !== "https:")
    return blocked("Only HTTPS endpoints are allowed.");
  if (url.username || url.password)
    return blocked("URL must not embed credentials.");
  const port = url.port === "" ? 443 : Number(url.port);
  if (!Number.isInteger(port) || !ALLOWED_PORTS.has(port))
    return blocked("Only the default HTTPS port (443) is allowed.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) return blocked("URL has no hostname.");
  // 主机名本身是字面 IP 时，立刻按地址规则判——不给「http://127.0.0.1 伪装域名」的机会
  if (isIpLiteral(hostname) && isBlockedAddress(hostname))
    return blocked("Endpoint resolves to a private or reserved address.");
  return { ok: true, hostname, port };
}

export function isIpLiteral(host: string): boolean {
  return isIpv4Literal(host) || host.includes(":"); // IPv6 字面量必含冒号
}

function isIpv4Literal(host: string): boolean {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255)
  );
}

/** IPv4 分段数值化；非法返回 null。 */
function ipv4Octets(host: string): number[] | null {
  if (!isIpv4Literal(host)) return null;
  return host.split(".").map(Number);
}

function isBlockedIpv4(host: string): boolean {
  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 本机网
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // 环回
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // 链路本地 + 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  // /24 级段必须看到第三段：只看 a.b 会把 192.0.0/16 全拦（误伤 192.0.1.1 等公网段）
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24 IETF 保留 + 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 0 && c >= 8 && c <= 15) return true; // 192.0.8/21–192.0.15/20 保留
  if (a === 192 && b === 0 && c >= 64 && c <= 71) return true; // NAT64 Well Services
  if (a === 192 && b === 0 && c >= 100 && c <= 101) return true; // 192.0.100.0/24 保留
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试 198.18/15
  if (a >= 224) return true; // 组播 224/4 与保留 240/4
  return false;
}

function ipv6Groups(host: string): bigint | null {
  // 极简 IPv6 数值化：展开 :: 补零后转 128bit 整数；非法返回 null。
  if (!/^[0-9a-fA-F:+.]+$/.test(host)) return null;
  const mappedIpv4 = host.match(/:(\d{1,3}(?:\.\d{1,3}){3})$/);
  let body = host;
  if (mappedIpv4) {
    const octets = ipv4Octets(mappedIpv4[1]);
    if (!octets) return null;
    const hex = octets
      .map((o) => o.toString(16).padStart(2, "0"))
      .join("");
    body = host.replace(mappedIpv4[1], `${hex.slice(0, 4)}:${hex.slice(4)}`);
  }
  const sides = body.split("::");
  if (sides.length > 2) return null;
  const toGroups = (part: string): string[] =>
    part === "" ? [] : part.split(":").map((g) => g.padStart(4, "0"));
  let groups: string[];
  if (sides.length === 2) {
    const head = toGroups(sides[0]);
    const tail = toGroups(sides[1]);
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array.from({ length: fill }, () => "0000"), ...tail];
  } else {
    groups = toGroups(body);
  }
  if (groups.length !== 8) return null;
  if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return BigInt("0x" + groups.map((g) => g.padStart(4, "0")).join(""));
}

function isBlockedIpv6(host: string): boolean {
  const value = ipv6Groups(host);
  if (value === null) return false;
  if (value === 0n) return true; // :: 未指定
  if (value === 1n) return true; // ::1 环回
  if (value >> BigInt(118) === 0b1111111010n) return true; // fe80::/10 链路本地
  if (value >> BigInt(121) === 0b1111110n) return true; // fc00::/7（含 fd00::/8 ULA）
  if (value >> BigInt(120) === 0xffn) return true; // ff00::/8 组播
  if (value >> BigInt(96) === 0n && (value & 0xffff_ffffn) !== 0n) {
    // ::ffff:a.b.c.d IPv4-mapped：按 IPv4 规则复核（V4-mapped 绕过是经典 SSRF 手法）
    const v4 = [(value >> 24n) & 0xffn, (value >> 16n) & 0xffn, (value >> 8n) & 0xffn, value & 0xffn].map(
      (n) => Number(n),
    );
    return isBlockedIpv4(v4.join("."));
  }
  return false;
}

/** 单个地址（v4/v6 字面量）是否属于内网/保留/元数据段。 */
export function isBlockedAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, "").split("%")[0];
  if (!host) return true;
  if (isIpv4Literal(host)) return isBlockedIpv4(host);
  if (host.includes(":")) return isBlockedIpv6(host);
  return false; // 域名：交由解析后逐 IP 判定
}

/**
 * DNS 解析结果整体判定：任何一个 IP 命中内网/保留段即拒绝（多 A 记录里藏 127.0.0.1 是常见绕过）。
 * 空解析视为拒绝——连目的地都没有的请求不该发出。
 */
export function assertResolvedAddresses(
  resolvedIps: readonly string[],
): { ok: boolean; reason?: string } {
  if (resolvedIps.length === 0)
    return { ok: false, reason: "Hostname did not resolve to any address." };
  for (const ip of resolvedIps) {
    if (isBlockedAddress(ip))
      return { ok: false, reason: "Endpoint resolves to a private or reserved address." };
  }
  return { ok: true };
}
