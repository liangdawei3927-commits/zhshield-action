import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseTscDiagnostics,
  resolveTscProjects,
  splitTscIssues,
  TypeScriptAdapter,
} from '../adapters/typescript-adapter';
import type { Issue } from '@zh/shared';

function mkIssue(ruleId: string, file: string): Issue {
  return {
    id: ruleId + file,
    ruleId,
    severity: 'error',
    category: 'quality',
    message: 'x',
    file,
    line: 1,
    column: 1,
    suggestion: '',
    autoFixable: false,
    source: 'inspect',
    fingerprint: ruleId + file,
  };
}

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

describe('splitTscIssues — 环境/安装类伪影过滤（P0-1 防假阳性）', () => {
  it('用户源码真错误保留；node_modules 报错与 TS2307/TS2580 解析错误判为伪影', () => {
    const all = [
      mkIssue('tsc/TS2322', '/repo/src/index.ts'), // 用户真错误，保留
      mkIssue('tsc/TS2307', '/repo/src/index.ts'), // 找不到模块，伪影
      mkIssue('tsc/TS2580', '/repo/src/app.ts'), // 找不到全局名，伪影
      mkIssue('tsc/TS2344', '/repo/node_modules/@nestjs/common/index.d.ts'), // node_modules，伪影
    ];
    const { issues, envArtifactCount } = splitTscIssues(all, '/repo');
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('tsc/TS2322');
    expect(envArtifactCount).toBe(3);
  });

  it('纯解析错误（TS2307 不含 node_modules 路径）也判为伪影', () => {
    // 依赖缺失时用户源码里也会报 TS2307，这不该作为门禁阻断依据
    const all = [mkIssue('tsc/TS2307', '/repo/src/service.ts')];
    const { issues, envArtifactCount } = splitTscIssues(all, '/repo');
    expect(issues).toHaveLength(0);
    expect(envArtifactCount).toBe(1);
  });
});

describe('TypeScriptAdapter.scan — 依赖缺失降级为未执行（P0-1）', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'tsc-deps-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('node_modules 缺失时返回 unavailable（降级，不阻断），不执行 tsc', async () => {
    // 有 tsconfig 但无 node_modules：模拟"clone 后未 npm install"
    writeFileSync(path.join(tempDir, 'tsconfig.json'), '{}');
    const adapter = new TypeScriptAdapter();
    const result = await adapter.scan({ projectPath: tempDir, timeout: 5000 });
    expect(result.status).toBe('unavailable');
    expect(result.issues).toHaveLength(0);
    expect(result.error).toContain('依赖未安装');
  });

  it('无 tsconfig 的非 TS 项目返回 available 且零问题（不阻断）', async () => {
    const adapter = new TypeScriptAdapter();
    const result = await adapter.scan({ projectPath: tempDir, timeout: 5000 });
    expect(result.status).toBe('available');
    expect(result.issues).toHaveLength(0);
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
