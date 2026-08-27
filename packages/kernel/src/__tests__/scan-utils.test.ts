import { describe, it, expect } from 'vitest';
import {
  isSafeRegexPattern,
  scanPatternsInFile,
  detectLayer,
} from '../runner/scan-utils';
import { makeRule } from './helpers/rule-factory';

const RULE = makeRule({ id: 'test/redos', severity: 'error' });

describe('isSafeRegexPattern（ReDoS 防护）', () => {
  it('接受 SOP 规则中的合法正则（字面量 / 简单量词）', () => {
    expect(isSafeRegexPattern('class.*Service')).toBe(true);
    expect(isSafeRegexPattern('base64.*bash')).toBe(true);
    expect(isSafeRegexPattern('(?:bash|sh|perl|python|ruby).*(?:-i|reverse|revshell|connect|callback)')).toBe(true);
    expect(isSafeRegexPattern('AKIA[0-9A-Z]{16}')).toBe(true);
  });

  it('拒绝灾难性回溯形态 (a+)+ / (a*)* / (a?)*', () => {
    expect(isSafeRegexPattern('(a+)+$')).toBe(false);
    expect(isSafeRegexPattern('(a*)*')).toBe(false);
    expect(isSafeRegexPattern('(a?)*')).toBe(false);
    expect(isSafeRegexPattern('((a+)+)')).toBe(false);
  });

  it('拒绝超长模式与括号不配对', () => {
    expect(isSafeRegexPattern('a'.repeat(600))).toBe(false);
    expect(isSafeRegexPattern('(unclosed')).toBe(false);
    expect(isSafeRegexPattern('unopened)')).toBe(false);
  });
});

describe('scanPatternsInFile（ReDoS 不阻塞主线程）', () => {
  it('灾难性模式被拒绝：快速返回空违规，不挂起', { timeout: 1000 }, () => {
    const content = 'a'.repeat(10_000);
    const violations = scanPatternsInFile(content, 'src/a.ts', RULE, ['(a+)+$']);
    expect(violations).toEqual([]);
  });

  it('超长模式被拒绝：快速返回空违规，不挂起', { timeout: 1000 }, () => {
    const content = 'x'.repeat(10_000);
    const violations = scanPatternsInFile(content, 'src/a.ts', RULE, ['x'.repeat(600)]);
    expect(violations).toEqual([]);
  });

  it('合法模式仍正常命中（行为保持）', () => {
    const violations = scanPatternsInFile('const apiKey = "AKIA1234567890ABCDEF";', 'src/a.ts', RULE, ['AKIA[0-9A-Z]{16}']);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.ruleId).toBe('test/redos');
  });
});

describe('detectLayer（层名安全校验）', () => {
  const layers = [
    { name: 'controller', allowedDependencies: ['service'] },
    { name: 'use-case', allowedDependencies: ['service'] },
  ];

  it('合法层名正常命中（行为保持）', () => {
    expect(detectLayer('src/controller/user.controller.ts', layers)).toBe('controller');
    expect(detectLayer('src/use-case/login.ts', layers)).toBe('use-case');
  });

  it('含正则元字符的层名被拒绝（不解释为正则）', () => {
    const evilLayers = [{ name: 'a.+b', allowedDependencies: [] }];
    expect(detectLayer('src/aXb/file.ts', evilLayers)).toBeNull();
    expect(detectLayer('src/a.+b/file.ts', evilLayers)).toBeNull();
  });

  it('超长 / 非法字符层名被跳过', () => {
    const evilLayers = [
      { name: 'x'.repeat(100), allowedDependencies: [] },
      { name: 'bad name!', allowedDependencies: [] },
    ];
    expect(detectLayer('src/x/file.ts', evilLayers)).toBeNull();
  });
});