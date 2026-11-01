/**
 * .env 解析 —— 与 python-dotenv 对齐的行为契约
 *
 * 起因（线上事故）：服务器 .env 里
 *   GUACAMOLE_URL=https://guac.example.com/guacamole/#/client/
 * 被 npm dotenv 截断成 `https://guac.example.com/guacamole/`，
 * /session/connect 拼出 `.../guacamole/3` 打到 Tomcat，返回
 * `404 The requested resource [/guacamole/3] is not available`；
 * 而 python-dotenv 保留 `#`，所以同一份 .env 在 Python 版下一直是好的。
 */
import { describe, expect, it } from 'vitest';
import { applyDotenv, parseDotenv } from '../../src/config/dotenv.js';

describe('parseDotenv: # 的处理（对齐 python-dotenv）', () => {
  it('未加引号值里的 # 不是注释，URL 的 /#/client/ 必须完整保留', () => {
    expect(parseDotenv('GUACAMOLE_URL=https://guac.example.com/guacamole/#/client/'))
      .toEqual({ GUACAMOLE_URL: 'https://guac.example.com/guacamole/#/client/' });
  });

  it('空白之后的 # 才是注释', () => {
    expect(parseDotenv('A=1 # comment').A).toBe('1');
    expect(parseDotenv('A=1\t# comment').A).toBe('1');
  });

  it('# 紧贴内容时整体保留', () => {
    expect(parseDotenv('A=1#2').A).toBe('1#2');
    expect(parseDotenv('C=#/x/').C).toBe('#/x/');
  });

  it('整行注释与空行被跳过', () => {
    expect(parseDotenv('# comment\n\nA=1')).toEqual({ A: '1' });
  });
});

describe('parseDotenv: 引号与其他语法', () => {
  it('引号内的 # 原样保留', () => {
    expect(parseDotenv('A="a#b"').A).toBe('a#b');
    expect(parseDotenv('B=\'c#d\'').B).toBe('c#d');
  });

  it('双引号内支持转义与跨行', () => {
    expect(parseDotenv('A="line1\\nline2"').A).toBe('line1\nline2');
    expect(parseDotenv('A="one\ntwo"').A).toBe('one\ntwo');
  });

  it('支持 export 前缀，脏行静默忽略', () => {
    expect(parseDotenv('export D=4\nnot a kv line\nE=5')).toEqual({ D: '4', E: '5' });
  });

  it('CRLF 换行同样能解析', () => {
    expect(parseDotenv('A=1\r\nB=2')).toEqual({ A: '1', B: '2' });
  });
});

describe('applyDotenv', () => {
  it('默认不覆盖已有环境变量（真实环境变量优先于 .env）', () => {
    const target: Record<string, string | undefined> = { A: 'from-real-env' };
    applyDotenv({ A: 'from-dotenv', B: '2' }, target);
    expect(target).toEqual({ A: 'from-real-env', B: '2' });
  });

  it('override: true 时覆盖', () => {
    const target: Record<string, string | undefined> = { A: 'old' };
    applyDotenv({ A: 'new' }, target, true);
    expect(target.A).toBe('new');
  });
});
