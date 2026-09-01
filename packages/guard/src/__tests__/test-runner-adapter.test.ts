import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TestCommandDetector } from '../adapters/test-command-detector';
import { TestRunnerAdapter } from '../adapters/test-runner-adapter';
import { VitestOutputParser } from '../adapters/vitest-output-parser';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      cb(Object.assign(new Error('Test execution failed'), { stdout: '', stderr: '' }));
    },
  ),
}));

type ParsedCounts = { totalTests: number; passed: number; failed: number };
type DetectedCommand = { testCmd: string; testArgs: string[] };
type DirResult = { dir: string } | { error: string };

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
}

describe('VitestOutputParser — 多包输出解析', () => {
  const parser = new VitestOutputParser();

  it('累加 turbo 多包 vitest 汇总行而非只取最后一条', () => {
    const counts: ParsedCounts = parser.parseVitestCounts([
      '@zh/db:test:       Tests  45 passed (45)',
      '@zh/kernel:test:       Tests  280 passed (280)',
      '@zh/desktop:test:       Tests  85 passed (85)',
    ]);
    expect(counts).toEqual({ totalTests: 410, passed: 410, failed: 0 });
  });

  it('解析含失败数的 vitest 汇总行', () => {
    const counts = parser.parseVitestCounts(['Tests  725 passed | 6 failed (731)']);
    expect(counts).toEqual({ totalTests: 731, passed: 725, failed: 6 });
  });

  it('解析 vitest v4 失败在前汇总行（failed | passed）', () => {
    const counts = parser.parseVitestCounts(['      Tests  3 failed | 44 passed (47)']);
    expect(counts).toEqual({ totalTests: 47, passed: 44, failed: 3 });
  });

  it('剥离 turbo 透传的 ANSI 颜色码后解析汇总行', () => {
    const ansiPassed =
      '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m68 passed\u001b[39m\u001b[22m\u001b[90m (68)\u001b[39m';
    const ansiMixed =
      '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m3 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m44 passed\u001b[39m\u001b[22m\u001b[90m (47)\u001b[39m';
    const counts = parser.parseVitestCounts([ansiPassed, ansiMixed]);
    expect(counts).toEqual({ totalTests: 115, passed: 112, failed: 3 });
  });

  it('跳过 Test Files 行与不含测试计数的行（turbo 任务摘要）', () => {
    const counts = parser.parseVitestCounts([
      ' Test Files  4 passed (4)',
      ' Tasks:    26 successful, 26 total',
      'Cached:    21 cached, 26 total',
    ]);
    expect(counts).toEqual({ totalTests: 0, passed: 0, failed: 0 });
  });
});

describe('TestCommandDetector — 测试命令探测', () => {
  const detector = new TestCommandDetector();

  it('turbo 包装的测试脚本追加 --output-logs=full 并经由 npx 执行', () => {
    expect(detector.toTestCommand('turbo run test')).toEqual({
      testCmd: 'npx',
      testArgs: ['turbo', 'run', 'test', '--output-logs=full'],
    } satisfies DetectedCommand);
  });

  it('vitest 脚本保持原行为', () => {
    expect(detector.toTestCommand('vitest run')).toEqual({
      testCmd: 'npx',
      testArgs: ['vitest', 'run'],
    } satisfies DetectedCommand);
  });
});

describe('TestCommandDetector — 项目目录解析', () => {
  const detector = new TestCommandDetector();

  it('projectPath 含 package.json 时直接使用', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"test":"vitest run"}}');
    expect(detector.resolveProjectDir(dir)).toEqual({ dir });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('projectPath 无 package.json 时向下查找含 test 脚本的子目录（嵌套仓库）', () => {
    const outer = makeTempDir();
    const inner = path.join(outer, 'zhiyan-codeshield');
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, 'package.json'), '{"scripts":{"test":"vitest run"}}');
    expect(detector.resolveProjectDir(outer)).toEqual({ dir: inner });
    fs.rmSync(outer, { recursive: true, force: true });
  });

  it('跳过无 test 脚本的子目录，查找下一个候选', () => {
    const outer = makeTempDir();
    const noScript = path.join(outer, '.opencode');
    fs.mkdirSync(noScript);
    fs.writeFileSync(path.join(noScript, 'package.json'), '{"scripts":{"dev":"node x.js"}}');
    const inner = path.join(outer, 'zhiyan-codeshield');
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, 'package.json'), '{"scripts":{"test":"turbo run test"}}');
    expect(detector.resolveProjectDir(outer)).toEqual({ dir: inner });
    fs.rmSync(outer, { recursive: true, force: true });
  });

  it('找不到含 test 脚本的 package.json 时报错', () => {
    const dir = makeTempDir();
    expect(detector.resolveProjectDir(dir)).toEqual({
      error: '未找到含 test 脚本的项目目录',
    } satisfies DirResult);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('TestRunnerAdapter — 输出解析失败的文件系统兜底', () => {
  const adapter = new TestRunnerAdapter();
  const parser = new VitestOutputParser();
  const check = {
    checkId: 'TEST-001',
    adapter: 'test-runner',
    enabled: true,
    mode: ['guard'] as const,
    category: 'quality',
    severity: 'error' as const,
    blocking: true,
    description: '',
  };

  it('统计磁盘真实测试文件，排除 node_modules / dist / 点目录', () => {
    const dir = makeTempDir();
    const testsDir = path.join(dir, 'src', '__tests__');
    fs.mkdirSync(testsDir, { recursive: true });
    fs.writeFileSync(
      path.join(testsDir, 'kernel.test.ts'),
      'import { it } from "vitest"; it("x", () => {});',
    );
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'fake.test.ts'), '');
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'built.test.ts'), '');
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'hooks.test.ts'), '');

    expect(parser.countTestFilesOnDisk(dir)).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('unresolved（解析不到但磁盘有测试）归一化为 warning 而非「未发现测试用例」', () => {
    const raw = {
      result: {
        command: 'vitest run',
        totalTests: 3,
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: 100,
        details: [],
        unresolved: true,
      },
    };
    const result = adapter.normalize(raw, {}, check);
    expect(result.status).toBe('warning');
    expect(result.message).not.toContain('未发现测试用例');
    expect(result.message).toContain('3 个测试文件');
  });

  it('磁盘与输出均无测试时才报「未发现测试用例」', () => {
    const raw = {
      result: {
        command: 'vitest run',
        totalTests: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: 100,
        details: [],
      },
    };
    const result = adapter.normalize(raw, {}, check);
    expect(result.status).toBe('warning');
    expect(result.message).toContain('未发现测试用例');
  });

  it('进程失败（超时/被杀）且输出无汇总行时，同样以磁盘测试文件兜底而非误报「未发现测试用例」', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"test":"vitest run"}}');
    const testsDir = path.join(dir, 'src', '__tests__');
    fs.mkdirSync(testsDir, { recursive: true });
    fs.writeFileSync(
      path.join(testsDir, 'kernel.test.ts'),
      'import { it } from "vitest"; it("x", () => {});',
    );

    const raw = await adapter.run({ projectPath: dir }, check);
    const result = adapter.normalize(raw, {}, check);
    expect(result.status).toBe('warning');
    expect(result.message).not.toContain('未发现测试用例');
    expect(result.message).toContain('1 个测试文件');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
