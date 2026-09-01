import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EnvConsistencyCheckerImpl } from '../adapters/env-consistency';
import type { ProjectProfile } from '../adapters/env-consistency';

/** 创建临时目录并登记清理 */
const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function writeNested(dir: string, rel: string, content: string): string {
  const filePath = path.join(dir, rel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

const checker = new EnvConsistencyCheckerImpl();

function profileOf(
  dir: string,
  packageManager: ProjectProfile['packageManager'] = 'pnpm',
): ProjectProfile {
  return {
    projectPath: dir,
    language: 'typescript',
    framework: 'NestJS',
    packageManager,
    hasTypeScript: true,
  };
}

describe('EnvConsistencyCheckerImpl', () => {
  it('lockfile-drift：锁文件版本不在 package.json 声明范围内 → error 条目', async () => {
    const dir = tmpDir('zh-env-drift-');
    writeFile(
      dir,
      'package.json',
      JSON.stringify({
        dependencies: { lodash: '^4.17.21', react: '^18.2.0' },
      }),
    );
    writeFile(
      dir,
      'pnpm-lock.yaml',
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      lodash:',
        '        specifier: ^4.17.21',
        '        version: 3.10.1',
        '      react:',
        '        specifier: ^18.2.0',
        '        version: 18.3.1',
      ].join('\n'),
    );

    const report = await checker.check(profileOf(dir));

    const drift = report.entries.filter((e) => e.kind === 'lockfile-drift');
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      name: 'lodash',
      kind: 'lockfile-drift',
      expected: '^4.17.21',
      actual: '3.10.1',
      severity: 'error',
    });
  });

  it('runtime-version：.nvmrc 与 engines.node 不一致 → error 条目', async () => {
    const dir = tmpDir('zh-env-runtime-');
    writeFile(dir, '.nvmrc', '18.20.2\n');
    writeFile(dir, 'package.json', JSON.stringify({ engines: { node: '^20.0.0' } }));

    const report = await checker.check(profileOf(dir));

    const runtime = report.entries.filter((e) => e.kind === 'runtime-version');
    expect(runtime).toHaveLength(1);
    expect(runtime[0]).toMatchObject({
      kind: 'runtime-version',
      name: 'node',
      severity: 'error',
    });
  });

  it('runtime-version：仅一处来源 → info 条目（不报 error）', async () => {
    const dir = tmpDir('zh-env-runtime-single-');
    writeFile(dir, '.nvmrc', '20.11.0\n');

    const report = await checker.check(profileOf(dir));

    const runtime = report.entries.filter((e) => e.kind === 'runtime-version');
    expect(runtime).toHaveLength(1);
    expect(runtime[0]).toMatchObject({ kind: 'runtime-version', severity: 'info' });
  });

  it('env-file-diff：.env 缺少 .env.example 键 → warning；.env 多余键 → info', async () => {
    const dir = tmpDir('zh-env-file-');
    writeFile(dir, '.env.example', 'API_KEY=\nDB_HOST=localhost\nLOG_LEVEL=info\n');
    writeFile(dir, '.env', 'API_KEY=secret\nEXTRA_FLAG=1\n');

    const report = await checker.check(profileOf(dir));

    const envDiff = report.entries.filter((e) => e.kind === 'env-file-diff');
    const missing = envDiff.filter((e) => e.severity === 'warning');
    const extra = envDiff.filter((e) => e.severity === 'info');
    expect(missing.map((e) => e.name).sort()).toEqual(['DB_HOST', 'LOG_LEVEL']);
    expect(extra.map((e) => e.name)).toEqual(['EXTRA_FLAG']);
  });

  it('ci-vs-local：工作流 Node 版本与 engines.node 不一致 → warning 条目', async () => {
    const dir = tmpDir('zh-env-ci-');
    writeFile(dir, 'package.json', JSON.stringify({ engines: { node: '20.11.0' } }));
    writeNested(
      dir,
      '.github/workflows/ci.yml',
      [
        'name: CI',
        'on: [push]',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: "18"',
      ].join('\n'),
    );

    const report = await checker.check(profileOf(dir));

    const ci = report.entries.filter((e) => e.kind === 'ci-vs-local');
    expect(ci).toHaveLength(1);
    expect(ci[0]).toMatchObject({
      kind: 'ci-vs-local',
      name: 'ci.yml node',
      expected: '本地 20.11.0',
      actual: 'CI 18',
      severity: 'warning',
    });
  });

  it('ci-vs-local：无 CI 工作流目录 → 不产出 ci-vs-local 条目', async () => {
    const dir = tmpDir('zh-env-ci-none-');
    writeFile(dir, 'package.json', JSON.stringify({ engines: { node: '20.11.0' } }));

    const report = await checker.check(profileOf(dir));

    expect(report.entries.filter((e) => e.kind === 'ci-vs-local')).toHaveLength(0);
  });

  it('多类问题同时存在 → 报告包含多种 kind 的条目', async () => {
    const dir = tmpDir('zh-env-multi-');
    writeFile(
      dir,
      'package.json',
      JSON.stringify({
        dependencies: { lodash: '^4.17.21' },
        engines: { node: '20.11.0' },
      }),
    );
    writeFile(
      dir,
      'pnpm-lock.yaml',
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      lodash:',
        '        specifier: ^4.17.21',
        '        version: 3.10.1',
      ].join('\n'),
    );
    writeFile(dir, '.nvmrc', '18.20.2\n');
    writeFile(dir, '.env.example', 'API_KEY=\n');
    writeFile(dir, '.env', 'OTHER=1\n');

    const report = await checker.check(profileOf(dir));

    const kinds = new Set(report.entries.map((e) => e.kind));
    expect(kinds.has('lockfile-drift')).toBe(true);
    expect(kinds.has('runtime-version')).toBe(true);
    expect(kinds.has('env-file-diff')).toBe(true);
    expect(report.entries.length).toBeGreaterThanOrEqual(4);
  });

  it('损坏 / 缺失文件 → 跳过对应类别且不抛异常', async () => {
    const dir = tmpDir('zh-env-corrupt-');
    writeFile(dir, 'package.json', '{not json');
    writeFile(dir, 'pnpm-lock.yaml', 'not: [valid');
    writeFile(dir, '.nvmrc', '\n');
    writeNested(dir, '.github/workflows/bad.yml', 'jobs: {broken');

    await expect(checker.check(profileOf(dir))).resolves.toBeDefined();
    const report = await checker.check(profileOf(dir));
    expect(report.entries).toEqual([]);
  });

  it('happy path：声明与锁文件 / 运行时 / 环境 / CI 全部一致 → 零条目', async () => {
    const dir = tmpDir('zh-env-happy-');
    writeFile(
      dir,
      'package.json',
      JSON.stringify({
        dependencies: { lodash: '^4.17.21' },
        engines: { node: '20.11.0' },
      }),
    );
    writeFile(
      dir,
      'pnpm-lock.yaml',
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      lodash:',
        '        specifier: ^4.17.21',
        '        version: 4.17.21',
      ].join('\n'),
    );
    writeFile(dir, '.nvmrc', '20.11.0\n');
    writeFile(dir, '.env.example', 'API_KEY=\n');
    writeFile(dir, '.env', 'API_KEY=secret\n');
    writeNested(
      dir,
      '.github/workflows/ci.yml',
      [
        'name: CI',
        'on: [push]',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: "20.11.0"',
      ].join('\n'),
    );

    const report = await checker.check(profileOf(dir));

    expect(report.entries).toEqual([]);
  });

  it('options.projectRoot 覆盖 profile.projectPath 定位清单', async () => {
    const root = tmpDir('zh-env-root-');
    const profile = profileOf(tmpDir('zh-env-profile-'));
    writeFile(root, 'package.json', JSON.stringify({ dependencies: { lodash: '^4.17.21' } }));
    writeFile(
      root,
      'pnpm-lock.yaml',
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      lodash:',
        '        specifier: ^4.17.21',
        '        version: 3.10.1',
      ].join('\n'),
    );

    const report = await checker.check(profile, { projectRoot: root });

    const drift = report.entries.filter((e) => e.kind === 'lockfile-drift');
    expect(drift).toHaveLength(1);
    expect(drift[0]?.name).toBe('lodash');
  });
});
