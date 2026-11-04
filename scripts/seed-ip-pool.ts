/**
 * 灌静态 IP 池 —— DESKTOP_SUBNET 配好后、开闸前必须跑一次
 *
 * 为什么需要它：`ensureDesktop` 在 DESKTOP_SUBNET 非空时走静态 IP 方案
 * （开机即可连，不必等 Guest 回读），地址从 `desktop_ip_allocations` 里
 * `state='free'` 的行里 SKIP LOCKED 取。池子是空的 → 所有 `/desktop/ensure`
 * 都会因拿不到地址失败，报错却像是别的问题。本脚本把网段内可用地址
 * 预先灌成 free 行。
 *
 * 用法（默认 dry-run，只打印计划不写库）：
 *   npx tsx scripts/seed-ip-pool.ts
 *   npx tsx scripts/seed-ip-pool.ts --subnet 172.25.3.0/24 --apply
 *
 * 可选：
 *   --gateway 172.25.3.1   跳过网关地址（默认用 DESKTOP_GATEWAY）
 *   --exclude .2,.3        追加排除（相对网段的尾段或完整 IP，逗号分隔）
 *   --first 20             只灌前 20 个可用地址（灰度先小池子）
 *
 * 幂等：`uq_desktop_ip` 唯一索引 + ON CONFLICT DO NOTHING，重跑只补缺口。
 */

interface Args {
  readonly subnet: string | undefined;
  readonly gateway: string | undefined;
  readonly exclude: readonly string[];
  readonly first: number | undefined;
  readonly apply: boolean;
}

const parseArgs = (argv: readonly string[]): Args => {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  return {
    subnet: get('--subnet'),
    gateway: get('--gateway'),
    exclude: (get('--exclude') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== ''),
    first: (() => {
      const raw = get('--first');
      return raw === undefined ? undefined : Number(raw);
    })(),
    apply: argv.includes('--apply'),
  };
};

/* ---------------- 零依赖 IPv4/CIDR 工具 ---------------- */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const ipToNum = (ip: string): number => {
  const match = IPV4_RE.exec(ip);
  if (match === null) throw new Error(`非法 IPv4 地址：${ip}`);
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) throw new Error(`非法 IPv4 地址：${ip}`);
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
};

const numToIp = (num: number): string =>
  [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');

const expandCidr = (cidr: string): { readonly network: number; readonly broadcast: number } => {
  const [ipPart, prefixPart] = cidr.split('/');
  const prefix = Number(prefixPart);
  if (ipPart === undefined || prefixPart === undefined || !Number.isInteger(prefix)
    || prefix < 8 || prefix > 32) {
    throw new Error(`非法 CIDR（需要 a.b.c.d/8..32）：${cidr}`);
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipToNum(ipPart) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { network, broadcast };
};

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));

  // ⚠️ settings 是模块级单例，import src/** 的瞬间就会校验配置 —— 所有 src 导入
  // 必须等 DATABASE_URL 就位后再动态进行（静态 import 会在本赋值之前触发校验）。
  // dry-run 不碰数据库：即使 .env 的 DATABASE_URL 不是 postgres 也照常跑；
  // --apply 则用真实 .env，配置非法时理应 fail-fast。
  if (!args.apply) {
    process.env.DATABASE_URL = 'postgres://dryrun:dryrun@127.0.0.1:5432/dryrun';
  }
  const { sql } = await import('drizzle-orm');
  const { getSettings } = await import('../src/config/env.js');
  const { getDb } = await import('../src/db/client.js');
  const { desktopIpAllocations } = await import('../src/db/schema.js');
  const settings = getSettings();

  const subnet = args.subnet ?? settings.desktopSubnet;
  if (subnet === undefined || subnet === '') {
    console.error('❌ 缺少网段：传 --subnet a.b.c.d/len，或在 .env 配 DESKTOP_SUBNET');
    return 2;
  }
  if (args.subnet !== undefined && args.subnet !== settings.desktopSubnet
    && settings.desktopSubnet !== '') {
    console.warn(`⚠️  --subnet=${args.subnet} 与 .env 的 DESKTOP_SUBNET=${settings.desktopSubnet} 不一致；`
      + 'ensureDesktop 只会取 DESKTOP_SUBNET 网段的地址，另一网段灌了也用不上');
  }

  const gateway = args.gateway ?? (settings.desktopGateway === '' ? undefined : settings.desktopGateway);

  const { network, broadcast } = expandCidr(subnet);
  const total = broadcast - network + 1;
  const hosts: number[] = [];
  // /31、/32 没有网络/广播保留地址的概念，其余掐头去尾
  const [lo, hi] = total > 2 ? [network + 1, broadcast - 1] : [network, broadcast];
  for (let num = lo; num <= hi; num += 1) hosts.push(num);

  const excludeNums = new Set<number>();
  if (gateway !== undefined) excludeNums.add(ipToNum(gateway));
  const networkPrefix = numToIp(network).split('.').slice(0, 3).join('.');
  for (const item of args.exclude) {
    // 相对写法：'.5' / '5' → 网段内尾段；否则按完整 IP
    let full = item;
    if (/^\d+$/.test(item)) full = `${networkPrefix}.${item}`;
    else if (item.startsWith('.')) full = `${networkPrefix}${item}`;
    excludeNums.add(ipToNum(full));
  }
  const candidates = hosts
    .filter((num) => !excludeNums.has(num))
    .map(numToIp)
    .slice(0, args.first ?? hosts.length);

  console.log(`\nIP 池计划  subnet=${subnet}  gateway=${gateway ?? '-'}  `
    + `排除=${excludeNums.size}  可灌=${candidates.length}  mode=${args.apply ? 'APPLY' : 'DRY-RUN'}\n`);
  if (candidates.length > 0) {
    console.log(`  首地址 ${candidates[0]}  末地址 ${candidates[candidates.length - 1]!}`);
  }
  if (candidates.length === 0) {
    console.error('❌ 计划为空：网段太小或排除项太多');
    return 1;
  }
  if (!args.apply) {
    console.log('\n（dry-run 结束；确认无误后加 --apply 写库）\n');
    return 0;
  }

  const db = getDb();
  // ON CONFLICT 打在 uq_desktop_ip (subnet, ip_address) 上：重跑幂等，只补缺口
  const inserted = await db.insert(desktopIpAllocations)
    .values(candidates.map((ipAddress) => ({ subnet, ipAddress, state: 'free' as const })))
    .onConflictDoNothing({ target: [desktopIpAllocations.subnet, desktopIpAllocations.ipAddress] })
    .returning({ id: desktopIpAllocations.id });

  console.log(`✅ 新增 ${inserted.length} 行（已存在的 ${candidates.length - inserted.length} 行跳过）`);

  // 池水位核对：与 service.poolStatus() 同口径
  const result = await db.execute(sql`
    SELECT count(*) FILTER (WHERE state = 'free')::int AS free_ip
    FROM desktop_ip_allocations
  `);
  const rows = (result as unknown as { rows: readonly { free_ip: number }[] }).rows ?? [];
  console.log(`✅ 池内 free 地址总数：${rows[0]?.free_ip ?? 0}\n`);
  return 0;
};

main()
  .then(async (code) => {
    if (process.argv.includes('--apply')) {
      // 只在真的开过连接池时收尾，否则进程不退出
      const { closeDatabase } = await import('../src/db/client.js');
      await closeDatabase();
    }
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error('\n❌ 灌池失败：');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
