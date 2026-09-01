import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { parseTscDiagnostics, resolveTscProjects } from '../adapters/typescript-adapter';

describe('parseTscDiagnostics — tsc 诊断行解析', () => {
  it('解析标准 error 行（含行列号）', () => {
    const issues = parseTscDiagnostics(
      "/repo/src/index.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      ruleId: 'tsc/TS2322',
      severity: 'error',
      file: '/repo/src/index.ts',
      line: 12,
      column: 5,
      message: "Type 'string' is not assignable to type 'number'. (TS2322)",
      autoFixable: false,
    });
  });

  it('解析 warning 行，只取错误码不含冒号后缀', () => {
    const issues = parseTscDiagnostics('/repo/a.ts(1,1): warning TS8000: deprecated usage');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      ruleId: 'tsc/TS8000',
      severity: 'warning',
      line: 1,
      column: 1,
    });
  });

  it('忽略与 tsc 格式无关的行（如 "Found 2 errors"）', () => {
    const issues = parseTscDiagnostics(
      'Found 2 errors. Watching for file changes.\n\n/ok.ts(1,1): error TS1000: x',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('tsc/TS1000');
  });

  it('空输入返回空数组', () => {
    expect(parseTscDiagnostics('')).toEqual([]);
  });

  it('路径含括号时仍正确解析（回溯到最后一个 (行,列)）', () => {
    const issues = parseTscDiagnostics('/repo/dir(a)/file.ts(3,2): error TS1110: boom');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file: '/repo/dir(a)/file.ts', line: 3, column: 2 });
  });
});

describe('resolveTscProjects — tsconfig 项目发现', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'tsc-projects-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('monorepo 根（根 tsconfig + packages/）→ 解析到各包 tsconfig', () => {
    writeFileSync(path.join(tempDir, 'tsconfig.json'), '{}');
    for (const pkg of ['a', 'b']) {
      mkdirSync(path.join(tempDir, 'packages', pkg), { recursive: true });
      writeFileSync(path.join(tempDir, 'packages', pkg, 'tsconfig.json'), '{}');
    }
    // 无 tsconfig 的包应被跳过
    mkdirSync(path.join(tempDir, 'packages', 'nolint'), { recursive: true });
    expect(
      resolveTscProjects(tempDir)
        .map((p) => path.basename(path.dirname(p)))
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('单项目（仅根 tsconfig）→ 返回根 tsconfig', () => {
    writeFileSync(path.join(tempDir, 'tsconfig.json'), '{}');
    expect(resolveTscProjects(tempDir)).toEqual([path.join(tempDir, 'tsconfig.json')]);
  });

  it('嵌套仓库（根无 tsconfig，一层子目录有）→ 返回子目录 tsconfig', () => {
    const repo = path.join(tempDir, 'my-repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, 'tsconfig.json'), '{}');
    expect(resolveTscProjects(tempDir)).toEqual([path.join(repo, 'tsconfig.json')]);
  });

  it('非 TypeScript 目录 → 空数组', () => {
    expect(resolveTscProjects(tempDir)).toEqual([]);
  });
});
