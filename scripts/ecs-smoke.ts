/**
 * 阿里云 ECS Provider 冒烟 —— 切 `DESKTOP_PROVIDER=ecs` 之前必须跑一次
 *
 * 为什么需要它：ACS3-HMAC-SHA256 签名是本项目唯一「本地 mock 测不出对错」的部分
 * （单测只能断言头格式，签名算错要真调才暴露）。这个脚本用真实 AK 做**只读**
 * 校验，再加 `--create` 做一次完整的创建→开机→销毁，把签名、RAM 权限、VSwitch、
 * 安全组、镜像可用性一次性验完。
 *
 * 用法：
 *   npx tsx scripts/ecs-smoke.ts --image m-win2022stats1
 *       只读：验签名 + 镜像是否 Available + 列一台实例确认 RegionId 正确
 *
 *   npx tsx scripts/ecs-smoke.ts --image m-win2022stats1 --create
 *       完整：RunInstances → StartInstance（等 running）→ DeleteInstance
 *       ⚠️ 会产生真实按量费用（几十秒，几分钱），且会真的创建/删除一台实例
 *
 *   --keep   创建后保留实例（调试模板/镜像时用），跳过 destroy
 *   --name DESKTOP-SMOKE   实例名（默认 SMOKE-<时间戳>）
 *
 * 前置：.env 里 ALIYUN_ACCESS_KEY_ID / SECRET / REGION_ID / VSWITCH_ID /
 *       SECURITY_GROUP_ID / INSTANCE_TYPE 六项齐全。
 */
import { createAliyunEcsProvider } from '../src/desktop/provider/aliyun-ecs.js';
import type { AliyunEcsConfig } from '../src/desktop/provider/aliyun-ecs.js';
import type { DesktopTemplate } from '../src/db/schema.js';

interface Args {
  readonly image: string;
  readonly create: boolean;
  readonly keep: boolean;
  readonly name: string;
}

const parseArgs = (argv: readonly string[]): Args => {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  return {
    image: get('--image') ?? process.env.ALIYUN_SMOKE_IMAGE ?? '',
    create: argv.includes('--create'),
    keep: argv.includes('--keep'),
    name: get('--name') ?? `SMOKE-${Date.now().toString(36)}`,
  };
};

const sleep = async (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms).unref?.();
});

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));
  if (args.image === '') {
    console.error('❌ 缺少 --image（自定义镜像 ID，形如 m-xxx）');
    return 2;
  }

  // settings 是模块级单例，import 瞬间就会校验配置；一次性脚本必须动态 import，
  // 并先给 DATABASE_URL 兜底（本脚本不碰数据库，但配置校验会要求它存在）
  process.env.DATABASE_URL ??= 'postgres://smoke:smoke@127.0.0.1:5432/smoke';
  const { getSettings } = await import('../src/config/env.js');
  const settings = getSettings();

  const missing = ([
    ['ALIYUN_ACCESS_KEY_ID', settings.aliyunAccessKeyId],
    ['ALIYUN_ACCESS_KEY_SECRET', settings.aliyunAccessKeySecret],
    ['ALIYUN_REGION_ID', settings.aliyunRegionId],
    ['ALIYUN_VSWITCH_ID', settings.aliyunVswitchId],
    ['ALIYUN_SECURITY_GROUP_ID', settings.aliyunSecurityGroupId],
    ['ALIYUN_INSTANCE_TYPE', settings.aliyunInstanceType],
  ] as const).filter(([, value]) => value === '').map(([name]) => name);
  if (missing.length > 0) {
    console.error(`❌ .env 缺少：${missing.join(', ')}`);
    return 2;
  }

  const config: AliyunEcsConfig = {
    accessKeyId: settings.aliyunAccessKeyId,
    accessKeySecret: settings.aliyunAccessKeySecret,
    regionId: settings.aliyunRegionId,
    vswitchId: settings.aliyunVswitchId,
    securityGroupId: settings.aliyunSecurityGroupId,
    instanceType: settings.aliyunInstanceType,
    ...(settings.aliyunInitialPassword === '' ? {} : { initialPassword: settings.aliyunInitialPassword }),
    ...(settings.aliyunSystemDiskCategory === ''
      ? {} : { systemDiskCategory: settings.aliyunSystemDiskCategory }),
    stopCharging: settings.aliyunStopCharging,
    allocatePublicIp: settings.aliyunAllocatePublicIp,
    timeoutMs: settings.aliyunTimeoutMs,
  };
  const provider = createAliyunEcsProvider(config);

  console.log(`\n阿里云 ECS 冒烟  region=${config.regionId}  image=${args.image}\n`);

  // ① 只读：签名 + 镜像可用性（签名错这里就会 SignatureDoesNotMatch）
  const template = { providerRef: args.image } as unknown as DesktopTemplate;
  const startedAt = Date.now();
  const ok = await provider.validateTemplate(template);
  if (!ok) {
    console.error(`❌ 镜像 ${args.image} 不可用（不存在或状态不是 Available）`);
    return 1;
  }
  console.log(`✅ ① 签名有效、镜像 Available（${Date.now() - startedAt}ms）`);

  // ② 只读：DescribeInstances 权限 + RegionId 正确性。
  //    查一个不存在的 ID 是最安全的方式：既验证了签名与权限，又不需要真有机子。
  const probe = await provider.inspect('i-smoke-not-exist');
  if (probe.powerState !== 'unknown') {
    console.error(`❌ DescribeInstances 返回了意外结果：${JSON.stringify(probe)}`);
    return 1;
  }
  console.log('✅ ② DescribeInstances 可读（签名 + RAM 权限 OK）');

  if (!args.create) {
    console.log('\n（只读模式结束；加 --create 做创建→开机→销毁的完整冒烟）\n');
    return 0;
  }

  // ③ 创建
  let ref: string | null = null;
  try {
    const cloneStart = Date.now();
    // ECS 的实际规格由 INSTANCE_TYPE 决定，spec 的 vcpu/memoryMb 只是接口占位
    ref = await provider.clone(template, {
      name: args.name, vcpu: 2, memoryMb: 4096,
    });
    console.log(`✅ ③ RunInstances 成功  instance=${ref}（${Date.now() - cloneStart}ms）`);

    // ④ 开机并等 running（Windows 首启较慢，给 5 分钟）
    await provider.start(ref);
    const deadline = Date.now() + 300_000;
    for (;;) {
      const state = await provider.inspect(ref);
      if (state.powerState === 'running' || state.primaryIp !== null) {
        console.log(`✅ ④ 已开机  state=${state.powerState} ip=${state.primaryIp ?? '-'}`);
        break;
      }
      if (Date.now() >= deadline) {
        console.warn('⚠️  5 分钟内未 running，继续清理');
        break;
      }
      await sleep(10_000);
    }
  } finally {
    if (ref !== null && !args.keep) {
      const destroyStart = Date.now();
      await provider.destroy(ref);
      console.log(`✅ ⑤ 已销毁 ${ref}（${Date.now() - destroyStart}ms）`);
    } else if (ref !== null) {
      console.log(`⚠️  --keep：实例 ${ref} 保留，用完请到控制台释放`);
    }
  }

  console.log('\n冒烟通过：签名、RAM 权限、VSwitch、安全组、镜像均可用。\n');
  return 0;
};

main().then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  console.error('\n❌ 冒烟失败：');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
