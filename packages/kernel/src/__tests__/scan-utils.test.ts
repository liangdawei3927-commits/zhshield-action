import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  isSafeRegexPattern,
  scanPatternsInFile,
  detectLayer,
  resolveFiles,
} from '../runner/scan-utils';
import { makeRule } from './helpers/rule-factory';

const RULE = makeRule({ id: 'test/redos', severity: 'error' });

describe('isSafeRegexPattern（ReDoS 防护）', () => {
  it('接受 SOP 规则中的合法正则（字面量 / 简单量词）', () => {
    expect(isSafeRegexPattern('class.*Service')).toBe(true);
    expect(isSafeRegexPattern('base64.*bash')).toBe(true);
    expect(
      isSafeRegexPattern('(?:bash|sh|perl|python|ruby).*(?:-i|reverse|revshell|connect|callback)'),
    ).toBe(true);
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
    // 测试夹具故意不使用凭证形状字面量，避免安全扫描误判
    const violations = scanPatternsInFile('const cmd = "sh -c reverse";', 'src/a.ts', RULE, [
      '(?:bash|sh|perl|python|ruby).*(?:-i|reverse|revshell|connect|callback)',
    ]);
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

describe('resolveFiles（源码根探测与回退）', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'scan-utils-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('显式 files + exts 过滤：只返回匹配扩展名的文件', () => {
    const files = resolveFiles({ repoRoot: tempDir, files: ['a.ts', 'b.js', 'c.tsx'] }, ['.ts']);
    expect(files).toEqual(['a.ts']);
  });

  it('显式 files 且无 exts：原样返回全部文件', () => {
    const files = resolveFiles({ repoRoot: tempDir, files: ['a.ts', 'b.js'] });
    expect(files).toEqual(['a.ts', 'b.js']);
  });

  it('src 布局：扫描 src/ 目录（行为保持）', () => {
    const srcDir = path.join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(path.join(srcDir, 'a.ts'), 'const a = 1;', 'utf-8');
    writeFileSync(path.join(srcDir, 'b.ts'), 'const b = 2;', 'utf-8');
    writeFileSync(path.join(srcDir, 'c.js'), 'const c = 3;', 'utf-8');

    const files = resolveFiles({ repoRoot: tempDir }, ['.ts']);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith('.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('a.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('b.ts'))).toBe(true);
  });

  it('packages 布局：src 缺失时回退到 packages/ 目录', () => {
    const pkgDir = path.join(tempDir, 'packages', 'core');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, 'main.go'), 'package main', 'utf-8');
    writeFileSync(path.join(pkgDir, 'util.go'), 'package main', 'utf-8');

    const files = resolveFiles({ repoRoot: tempDir }, ['.go']);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith('main.go'))).toBe(true);
    expect(files.some((f) => f.endsWith('util.go'))).toBe(true);
  });

  it('根目录密度布局：无候选目录但根目录源码文件数达阈值时直接扫根目录', () => {
    writeFileSync(path.join(tempDir, 'main.go'), 'package main', 'utf-8');
    writeFileSync(path.join(tempDir, 'util.go'), 'package main', 'utf-8');
    writeFileSync(path.join(tempDir, 'helper.go'), 'package main', 'utf-8');
    // 噪声目录应被跳过
    mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
    writeFileSync(path.join(tempDir, 'node_modules', 'dep.go'), 'package dep', 'utf-8');

    const files = resolveFiles({ repoRoot: tempDir }, ['.go']);
    expect(files).toHaveLength(3);
    expect(files.some((f) => f.endsWith('main.go'))).toBe(true);
    expect(files.some((f) => f.endsWith('node_modules'))).toBe(false);
  });

  it('空根目录：无候选目录且根目录源码文件不足阈值时返回空数组', () => {
    mkdirSync(path.join(tempDir, 'empty'), { recursive: true });
    const files = resolveFiles({ repoRoot: path.join(tempDir, 'empty') }, ['.ts']);
    expect(files).toEqual([]);
  });
});
