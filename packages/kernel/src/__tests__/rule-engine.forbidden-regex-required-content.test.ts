import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SopRuleEngine } from '../runner';
import { ContentInterpreter } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';

/**
 * 新增内联评估类型测试：forbidden-regex / required-content
 *
 * 测试意图（Rule 9）：这两类指令是「空骨架规则补实」的核心检出能力——
 * - forbidden-regex 负责按正则禁止危险写法（如 eval、any 断言）；
 * - required-content 负责验证文档/配置必需内容（README 章节、tsconfig strict、导出 JSDoc）。
 * 若检出能力失效（误报 passed），空骨架补实工作将形同虚设，因此每条测试都验证
 * 「该报时报、该过时过」，而非仅验证不抛异常。
 */
describe('SopRuleEngine — forbidden-regex / required-content 内联评估', () => {
  let registry: SopRegistry;
  let engine: SopRuleEngine;
  let tempDir: string;

  beforeEach(() => {
    registry = new SopRegistry();
    engine = new SopRuleEngine(registry);
    tempDir = mkdtempSync(path.join(tmpdir(), 'rule-engine-v2-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── 解释器分支 ─────────────────────────────────────────

  it('解释器: forbiddenRegex 内容 → forbidden-regex 指令（含 message/suggestion 透传）', () => {
    const interpreter = new ContentInterpreter();
    const rule = makeRule({
      id: 'inspect.scan.no-eval',
      domain: 'inspect',
      applicableEngines: ['inspect'],
      content: {
        forbiddenRegex: [
          { regex: '\\beval\\s*\\(', message: '禁止使用 eval', suggestion: '改用 JSON.parse' },
        ],
        fileExts: ['.ts', '.js'],
      },
    });
    const instr = interpreter.interpret(rule);
    expect(instr.type).toBe('forbidden-regex');
    if (instr.type === 'forbidden-regex') {
      expect(instr.items).toHaveLength(1);
      expect(instr.items[0].regex).toBe('\\beval\\s*\\(');
      expect(instr.items[0].message).toBe('禁止使用 eval');
      expect(instr.items[0].suggestion).toBe('改用 JSON.parse');
      expect(instr.fileExts).toEqual(['.ts', '.js']);
    }
  });

  it('解释器: required 内容 → required-content 指令（含 contains/json/jsdocOn 透传）', () => {
    const interpreter = new ContentInterpreter();
    const rule = makeRule({
      id: 'inspect.scan.readme',
      domain: 'inspect',
      applicableEngines: ['inspect'],
      content: {
        required: [
          {
            path: 'README.md',
            contains: ['## 快速开始'],
            containsAny: [['## 安装', '## Install']],
          },
          { path: 'tsconfig.json', json: { 'compilerOptions.strict': true } },
          { path: 'src', fileExts: ['.ts'], jsdocOn: ['^export\\s+(interface|type)\\s+'] },
        ],
      },
    });
    const instr = interpreter.interpret(rule);
    expect(instr.type).toBe('required-content');
    if (instr.type === 'required-content') {
      expect(instr.items).toHaveLength(3);
      expect(instr.items[0].contains).toEqual(['## 快速开始']);
      expect(instr.items[0].containsAny).toEqual([['## 安装', '## Install']]);
      expect(instr.items[1].json).toEqual({ 'compilerOptions.strict': true });
      expect(instr.items[2].jsdocOn).toEqual(['^export\\s+(interface|type)\\s+']);
    }
  });

  // ── forbidden-regex 引擎评估 ───────────────────────────

  it('forbidden-regex: 命中禁止正则时 failed 且违规含行号与自定义 message', async () => {
    const srcDir = path.join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      path.join(srcDir, 'bad.ts'),
      ['const a: any = 1;', 'eval("1+1");', 'const ok = 42;'].join('\n'),
      'utf-8',
    );

    registry.register(
      makeRule({
        id: 'inspect.scan.no-eval',
        domain: 'inspect',
        applicableEngines: ['inspect'],
        content: {
          forbiddenRegex: [
            { regex: '\\beval\\s*\\(', message: '禁止使用 eval' },
            { regex: ':\\s*any\\b', message: '禁止 any 断言' },
          ],
          fileExts: ['.ts'],
        },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: tempDir, domain: 'inspect' });
    expect(report.total).toBe(1);
    expect(report.failed).toBe(1);
    const violations = report.evaluations[0].violations!;
    // 该报不报 = 检出能力失效
    expect(violations.some((v) => v.message === '禁止使用 eval' && v.line === 2)).toBe(true);
    expect(violations.some((v) => v.message === '禁止 any 断言' && v.line === 1)).toBe(true);
  });

  it('forbidden-regex: 无命中时 passed（不误伤正常代码）', async () => {
    const srcDir = path.join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      path.join(srcDir, 'good.ts'),
      ['const total = items.reduce((acc, x) => acc + x, 0);'].join('\n'),
      'utf-8',
    );

    registry.register(
      makeRule({
        id: 'inspect.scan.no-eval',
        domain: 'inspect',
        content: {
          forbiddenRegex: [{ regex: '\\beval\\s*\\(' }],
          fileExts: ['.ts'],
        },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: tempDir });
    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.ok).toBe(true);
  });

  it('forbidden-regex: 无效/危险正则静默跳过，不崩溃也不误报', async () => {
    const srcDir = path.join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(path.join(srcDir, 'a.ts'), 'const x = 1;\n', 'utf-8');

    registry.register(
      makeRule({
        id: 'inspect.scan.bad-regex',
        domain: 'inspect',
        content: {
          forbiddenRegex: [
            { regex: '([a+)+', message: '语法非法正则' }, // 无法编译
            { regex: '(a+)+$', message: '灾难性回溯形态' }, // ReDoS 危险
            { regex: 'never-matched-literal-xyz', message: '正常但无命中' },
          ],
          fileExts: ['.ts'],
        },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: tempDir });
    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
  });

  it('forbidden-regex: excludePatterns 命中的文件不参与扫描', async () => {
    const srcDir = path.join(tempDir, 'src');
    mkdirSync(path.join(srcDir, 'legacy'), { recursive: true });
    writeFileSync(path.join(srcDir, 'main.ts'), 'eval("1");\n', 'utf-8');
    writeFileSync(path.join(srcDir, 'legacy', 'old.ts'), 'eval("2");\n', 'utf-8');

    registry.register(
      makeRule({
        id: 'inspect.scan.no-eval',
        domain: 'inspect',
        content: {
          forbiddenRegex: [{ regex: '\\beval\\s*\\(' }],
          fileExts: ['.ts'],
          excludePatterns: ['src/legacy/**'],
        },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: tempDir });
    const violations = report.evaluations[0].violations!;
    expect(report.failed).toBe(1);
    expect(violations.every((v) => !v.file.includes('legacy'))).toBe(true);
    expect(violations.some((v) => v.file.includes('main.ts'))).toBe(true);
  });

  // ── required-content 引擎评估 ──────────────────────────

  it('required-content: 必需文件缺失时 failed', async () => {
    registry.register(
      makeRule({
        id: 'inspect.scan.readme',
        domain: 'inspect',
        content: {
          required: [{ path: 'README.md', contains: ['## 快速开始'] }],
        },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: tempDir });
    expect(report.failed).toBe(1);
    const violations = report.evaluations[0].violations!;
    expect(violations.some((v) => v.message.includes('缺少必需文件: README.md'))).toBe(true);
  });

  it('required-content: contains 缺失报 violated，containsAny 任一命中即通过', async () => {
    writeFileSync(
      path.join(tempDir, 'README.md'),
      ['# 项目\n', '## Install\n', '## 贡献指南\n'].join('\n'),
      'utf-8',
    );

    registry.register(
      makeRule({
        id: 'inspect.scan.readme',
        domain: 'inspect',
        content: {
          required: [
            {
              path: 'README.md',
              contains: ['## 缺失的章节'],
              containsAny: [['## 安装', '## Install']],
            },
          ],
        },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: tempDir });
    const violations = report.evaluations[0].violations!;
    expect(report.failed).toBe(1);
    // containsAny 命中 → 不产生该组违规；仅 contains 缺失违规
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('缺少必需内容: "## 缺失的章节"');
  });

  it('required-content: json 键路径检查 — strict=false 或缺失时 failed，true 时 passed', async () => {
    registry.register(
      makeRule({
        id: 'inspect.scan.tsconfig-strict',
        domain: 'inspect',
        content: {
          required: [{ path: 'tsconfig.json', json: { 'compilerOptions.strict': true } }],
        },
      }),
    );

    // JSONC 形式（带注释/尾逗号）也应可解析
    writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      ['{', '  // 编译选项', '  "compilerOptions": {', '    "strict": false,', '  },', '}'].join(
        '\n',
      ),
      'utf-8',
    );
    const failReport = await engine.evaluateRules({ repoRoot: tempDir });
    expect(failReport.failed).toBe(1);
    expect(
      failReport.evaluations[0].violations!.some((v) =>
        v.message.includes('compilerOptions.strict'),
      ),
    ).toBe(true);

    writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true } }),
      'utf-8',
    );
    const passReport = await engine.evaluateRules({ repoRoot: tempDir });
    expect(passReport.passed).toBe(1);
  });

  it('required-content: jsdocOn — 导出声明缺 JSDoc 时 failed（含行号），补齐后 passed', async () => {
    const srcDir = path.join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    const filePath = path.join(srcDir, 'types.ts');

    registry.register(
      makeRule({
        id: 'inspect.scan.jsdoc',
        domain: 'inspect',
        content: {
          required: [
            { path: 'src', fileExts: ['.ts'], jsdocOn: ['^export\\s+(interface|type)\\s+'] },
          ],
        },
      }),
    );

    writeFileSync(
      filePath,
      ['export interface User {', '  id: string;', '}', ''].join('\n'),
      'utf-8',
    );
    const failReport = await engine.evaluateRules({ repoRoot: tempDir });
    expect(failReport.failed).toBe(1);
    const violations = failReport.evaluations[0].violations!;
    expect(violations.some((v) => v.message.includes('缺少 JSDoc') && v.line === 1)).toBe(true);

    writeFileSync(
      filePath,
      ['/** 用户实体 */', 'export interface User {', '  id: string;', '}', ''].join('\n'),
      'utf-8',
    );
    const passReport = await engine.evaluateRules({ repoRoot: tempDir });
    expect(passReport.passed).toBe(1);
  });
});
