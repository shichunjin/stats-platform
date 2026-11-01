/**
 * 私有地址判定 —— 对 Python 没有对应用例（原实现直接用标准库 ipaddress），
 * TS 侧手写了 src/security/ip.ts，因此需要专门覆盖。
 *
 * 这里断言的是「Python `ipaddress.ip_address(h).is_private` 的等价行为」，
 * 逐项对齐其 _private_networks 常量表。
 */
import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from '../../src/security/ip.js';

describe('isPrivateAddress', () => {
  it.each([
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '127.0.0.1',
    '169.254.1.1',
    '0.1.2.3',
    '240.0.0.1',
    '255.255.255.255',
    '192.0.2.1',
    '198.51.100.7',
    '203.0.113.9',
    '198.18.0.1',
    '192.0.0.1',
    '192.0.0.171',
  ])('私有/保留 IPv4: %s', (host) => {
    expect(isPrivateAddress(host)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.15.255.255',
    '172.32.0.1',
    '11.0.0.1',
    '114.114.114.114',
  ])('公网 IPv4: %s', (host) => {
    expect(isPrivateAddress(host)).toBe(false);
  });

  it.each([
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:192.168.1.1',
    '2001:db8::1',
  ])('私有 IPv6: %s', (host) => {
    expect(isPrivateAddress(host)).toBe(true);
  });

  it.each(['2001:4860:4860::8888', '2606:4700:4700::1111'])('公网 IPv6: %s', (host) => {
    expect(isPrivateAddress(host)).toBe(false);
  });

  // SSRF 白名单场景：域名必须一律拒绝（不解析 DNS，避免 DNS rebinding）
  it.each([
    'example.com',
    'localhost.localdomain',
    'metadata.google.internal',
    'foo',
    '',
  ])('域名/非法输入一律 false: %s', (host) => {
    expect(isPrivateAddress(host)).toBe(false);
  });

  it.each(['010.1.1.1', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.999'])(
    '畸形字面量 false: %s',
    (host) => {
      expect(isPrivateAddress(host)).toBe(false);
    },
  );

  it('带 zone id 的链路本地地址仍按私有处理', () => {
    expect(isPrivateAddress('fe80::1%eth0')).toBe(true);
  });

  it('IPv6 前导零与大小写都能解析', () => {
    expect(isPrivateAddress('FD00::0001')).toBe(true);
    expect(isPrivateAddress('::FFFF:192.168.1.1')).toBe(true);
  });
});
