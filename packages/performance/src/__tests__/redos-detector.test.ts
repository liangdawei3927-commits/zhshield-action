import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RedosDetectorImpl, hasNestedUnboundedQuantifier } from '../adapters/redos-detector';

/**
 * ReDoS 探测器的验收用例。
 *
 * 锁定的不变量：
 *   1) 「不定量词嵌套」是灾难性回溯的直接签名，必须命中（`(a+)+` / `(.*)*` / `(\d+)+`）；
 *   2) 良性正则不得误报（交替 `(a|b)+`、普通 `\d+`、字符类里的 `+`、可选量词）；
 *   3) 探测器对目录执行时产出 `performance.redos.*` 命名空间的问题（能力闭环证据）。
 */
describe('hasNestedUnboundedQuantifier — 危险模式命中', () => {
  it.each([
    ['(a+)+', '经典嵌套加号'],
    ['(.*)*', '通配符双层星号'],
    ['(\\d+)+', '数字嵌套'],
    ['([a-z]*)*', '字符类内层星号'],
    ['(?:a+)+', '非捕获分组也危险'],
    ['(\\w+\\s?)+', '词字符嵌套'],
  ])('命中危险模式 %s（%s）', (pattern) => {
    expect(hasNestedUnboundedQuantifier(pattern)).toBe(true);
  });
});

describe('hasNestedUnboundedQuantifier — 良性模式不误报', () => {
  it.each([
    ['(a|b)+', '交替但无内层不定量词'],
    ['\\d+', '顶层普通量词'],
    ['\\d+\\.\\d+', 'IP/版本号数字'],
    ['[a+]+', '字符类里的 + 是字面量'],
    ['(abc)', '无外层量词'],
    ['(?:ab)+', '非捕获但内部无不定量词'],
    ['(a+)?', '内层不定量词但外层是可选（有界）'],
    ['^\\w+@\\w+\\.\\w+$', '常见邮箱'],
  ])('不误报 %s（%s）', (pattern) => {
    expect(hasNestedUnboundedQuantifier(pattern)).toBe(false);
  });
});

describe('RedosDetectorImpl.detect — 端到端产出性能问题', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redos-detect-'));
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('命中源码中的正则字面量并给出 performance.redos 规则', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'bad.ts'),
      'export const re = /(a+)+$/;\nexport const use = (s: string) => re.test(s);\n',
      'utf-8',
    );

    const issues = new RedosDetectorImpl().detect(projectRoot);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    const hit = issues.find((i) => i.file === 'src/bad.ts');
    expect(hit).toBeDefined();
    expect(hit!.ruleId).toBe('performance.redos.catastrophic-backtracking');
    expect(hit!.category).toBe('regex-safety');
    expect(hit!.autoFixable).toBe(false);
    expect(hit!.line).toBeGreaterThanOrEqual(1);
  });

  it('命中 new RegExp("...") 形式的静态字符串模式', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'ctor.ts'),
      'export const re = new RegExp("(\\\\d+)+");\n',
      'utf-8',
    );

    const issues = new RedosDetectorImpl().detect(projectRoot);
    expect(issues.some((i) => i.file === 'src/ctor.ts')).toBe(true);
  });

  it('良性源码零告警', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'good.ts'),
      'export const re = /\\d+\\.\\d+/;\nexport const alt = /(foo|bar)+/;\n',
      'utf-8',
    );

    const issues = new RedosDetectorImpl().detect(projectRoot);
    expect(issues).toHaveLength(0);
  });

  it('无源码根时静默返回空（不抛异常）', () => {
    fs.rmSync(path.join(projectRoot, 'src'), { recursive: true, force: true });
    expect(() => new RedosDetectorImpl().detect(projectRoot)).not.toThrow();
    expect(new RedosDetectorImpl().detect(projectRoot)).toEqual([]);
  });
});
