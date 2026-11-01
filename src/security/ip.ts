/**
 * 私有地址判定 —— 对应 Python `ipaddress.ip_address(host).is_private`
 *
 * Python 标准库自带 ipaddress，Node 没有等价内置模块。这里手写一份，
 * 用于 B3 SSRF 防护（管理端「测试连接」与「保存平台配置」的目标主机白名单）。
 *
 * 行为对齐要点：
 * - 只认字面量 IP，**域名一律返回 false**（Python 侧也是：域名走 ValueError 分支）
 * - 覆盖 Python `_private_networks` 的全部 IPv4 段（含 127/8 回环、169.254/16 链路本地、
 *   以及 192.0.2/24、198.51.100/24、203.0.113/24 三个文档保留段）
 * - 覆盖 IPv6 的 fc00::/7、fe80::/10、::ffff:0:0/96 等
 * - 解析失败（含 `::` 未压缩任何组这类畸形写法）按「非私有」处理 —— 对白名单场景是 fail-closed
 */

type Ipv4Tuple = readonly [number, number, number, number];

/* ---------------- IPv4 ---------------- */

const parseIpv4 = (host: string): Ipv4Tuple | null => {
  // 手写而非 net.isIPv4：需要明确拒绝前导零（'010.1.1.1' 在 Python 3.9.5+ 同样非法）
  const parts = host.split('.');
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
};

const toUint32 = (addr: Ipv4Tuple): number =>
  (((addr[0] << 24) | (addr[1] << 16) | (addr[2] << 8) | addr[3]) >>> 0);

/** prefix 为 0 时掩码为 0（Python 允许 /0）；无符号右移保证结果恒为正数 */
const v4Mask = (prefix: number): number => (prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

const inBlockV4 = (addr: Ipv4Tuple, base: Ipv4Tuple, prefix: number): boolean => {
  const mask = v4Mask(prefix);
  return ((toUint32(addr) & mask) >>> 0) === ((toUint32(base) & mask) >>> 0);
};

/** Python ipaddress._constants._private_networks 中的 IPv4 部分 */
const IPV4_PRIVATE_BLOCKS: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 29],
  ['192.0.0.170', 31],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
];

const IPV4_PARSED: readonly (readonly [Ipv4Tuple, number])[] = IPV4_PRIVATE_BLOCKS.map(
  ([base, prefix]) => [parseIpv4(base)!, prefix],
);

/* ---------------- IPv6 ---------------- */

/**
 * 展开为 16 字节。不依赖 net.isIPv6，因为模块加载时要展开下方常量表
 * （net.isIPv6 也可用，但它不接受 `::ffff:0:0` 之外的写法差异，自己解析更可控）。
 */
export const parseIpv6 = (host: string): Uint8Array | null => {
  // 去掉网卡 zone（fe80::1%eth0）；Python 3.9+ 才支持 scope id，白名单场景直接忽略
  const addr = host.split('%', 1)[0]!.toLowerCase();
  if (addr.length === 0) return null;

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const parseHalf = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const raw of part.split(':')) {
      if (raw === '') return null;
      // 末组允许内嵌 IPv4：::ffff:192.168.1.1
      if (raw.includes('.')) {
        const v4 = parseIpv4(raw);
        if (v4 === null) return null;
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(raw)) return null;
      groups.push(Number.parseInt(raw, 16));
    }
    return groups;
  };

  const head = parseHalf(halves[0] ?? '');
  if (head === null) return null;
  const tail = halves.length === 2 ? parseHalf(halves[1] ?? '') : null;
  if (tail === null) return null;

  const groups: number[] = [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups.push(...head);
  } else {
    // '::' 必须至少压缩一个全零组，否则视为畸形
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups.push(...head, ...Array<number>(fill).fill(0), ...tail);
  }

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >>> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
};

const inBlockV6 = (addr: Uint8Array, base: Uint8Array, prefix: number): boolean => {
  for (let index = 0; index < 16; index += 1) {
    const bits = prefix - index * 8;
    if (bits <= 0) return true;
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((addr[index]! & mask) !== (base[index]! & mask)) return false;
  }
  return true;
};

const IPV6_PRIVATE_BLOCKS: readonly (readonly [string, number])[] = [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
];

const IPV6_PARSED: readonly (readonly [Uint8Array, number])[] = IPV6_PRIVATE_BLOCKS.map(
  ([base, prefix]) => [parseIpv6(base)!, prefix],
);

/* ---------------- 对外入口 ---------------- */

/**
 * 是否为私有/保留地址。域名、非法字面量一律 false。
 * 与 Python 的 `_is_allowed_test_host` 里 `ipaddress.ip_address(host).is_private`
 * 语义一致（ValueError → False）。
 */
export const isPrivateAddress = (host: string): boolean => {
  const v4 = parseIpv4(host);
  if (v4 !== null) {
    return IPV4_PARSED.some(([base, prefix]) => inBlockV4(v4, base, prefix));
  }

  const v6 = parseIpv6(host);
  if (v6 !== null) {
    return IPV6_PARSED.some(([base, prefix]) => inBlockV6(v6, base, prefix));
  }

  return false;
};
