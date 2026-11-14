import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuardESLintCheckAdapter } from '../adapters/eslint-check-adapter';
import { TestRunnerAdapter } from '../adapters/test-runner-adapter';
import type { CheckConfig } from '../types';

/**
 * 「项目没配置」≠「检查失败」。
 *
 * 2026-09-17 R9 实测：无 eslint.config.* 的项目会被 LINT-001 判成 error，
 * 无 test 脚本的项目会被 TEST-001 判成 **blocking error** —— 用户什么都没做错，
 * 门禁却红了。本文件把这条语义锁死：缺配置 = warning + 不阻断 + 明确写「已跳过」。
 */

let execFileMock: ReturnType<typeof vi.fn>;

/**
 * 包装成与原生 `execFile` 等价的形态。
 *
 * 两个契约都必须复刻，缺一个用例就会假红（2026-11-14 实测）：
 *   ① 回调是 `(error, stdout, stderr)` 三个位置参数，**stdout 是字符串**。
 *      产品侧走 `promisify(execFile)`，按真实契约取第二参数；此前用例传
 *      `cb(null, { stdout, stderr })`（把对象当 stdout），解析出 `"[object Object]"`，
 *      `JSON.parse` 失败 → 判 error，用例红得像是产品缺陷。
 *   ② 必须带 `util.promisify.custom`。丢掉它，promisify 会退回「回调单值」形态，
 *      stdout 变 undefined —— `scripts/lib/tool-spy.cjs` 已把这个坑记录在案。
 */
vi.mock('node:child_process', () => {
  const execFile = (...args: unknown[]) => execFileMock(...args);
  Object.defineProperty(execFile, promisify.custom, {
    value: (file: string, args: string[], options: unknown) =>
      new Promise((resolve, reject) => {
        execFileMock(file, args, options, (error: Error | null, stdout: string, stderr: string) => {
          if (error) {
            reject(Object.assign(error, { stdout, stderr }));
            return;
          }
          resolve({ stdout, stderr });
        });
      }),
  });
  return { execFile };
});

function makeCheck(overrides: Partial<CheckConfig> = {}): CheckConfig {
  return {
    checkId: 'LINT-001',
    adapter: 'eslint-check',
    enabled: true,
    mode: ['guard'],
    category: 'quality',
    severity: 'warning',
    blocking: false,
    description: 'ESLint 代码质量检查',
    ...overrides,
  };
}

/** TEST-001 的真实配置：severity=error 且 blocking=true —— 走 makeResult 会直接阻断门禁 */
function makeBlockingTestCheck(): CheckConfig {
  return makeCheck({
    checkId: 'TEST-001',
    adapter: 'test-runner',
    severity: 'error',
    blocking: true,
  });
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guard-skip-'));
}

const tempDirs: string[] = [];

function tempDirWith(files: Record<string, string>): string {
  const dir = makeTempDir();
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
  }
  return dir;
}

beforeEach(() => {
  execFileMock = vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (e: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, '[]', '');
    },
  );
});

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('GuardESLintCheckAdapter — 无 ESLint 配置时跳过而不是判失败', () => {
  it('项目没有任何 ESLint 配置 → warning / 不阻断 / 文案含「已跳过」', async () => {
    const dir = tempDirWith({ 'src/index.ts': 'export const a = 1;\n' });
    const adapter = new GuardESLintCheckAdapter();
    const check = makeCheck();

    const raw = await adapter.run({ projectPath: dir }, check);
    const result = adapter.normalize(raw, {}, check);

    expect(result.status).toBe('warning');
    expect(result.severity).toBe('warning');
    expect(result.blocking).toBe(false);
    expect(result.message).toContain('已跳过');
    expect(result.details).toMatchObject({ skipped: true });
    // 关键：没配置就不该去调 eslint（否则必然拿到一条 EPERN/EPERM 式的假失败）
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('有 eslint.config.js 时不跳过，正常执行并解析输出', async () => {
    const dir = tempDirWith({
      'eslint.config.js': 'export default [];\n',
      'src/index.ts': 'export const a = 1;\n',
    });
    execFileMock = vi.fn(
      (
        _c: string,
        _a: string[],
        _o: unknown,
        cb: (e: Error | null, stdout: string, stderr: string) => void,
      ) =>
        cb(
          null,
          JSON.stringify([
            {
              filePath: path.join(dir, 'src/index.ts'),
              messages: [
                { ruleId: 'no-console', message: 'no console', severity: 1, line: 1, column: 1 },
              ],
            },
          ]),
          '',
        ),
    );
    const adapter = new GuardESLintCheckAdapter();
    const check = makeCheck();

    const raw = await adapter.run({ projectPath: dir }, check);
    const result = adapter.normalize(raw, {}, check);

    expect(execFileMock).toHaveBeenCalled();
    expect(result.status).toBe('warning');
    expect(result.message).toContain('no-console');
    expect(result.details).toMatchObject({ totalWarnings: 1 });
    // 显式超时：本用例会穿透到 @zh/shared 的 resolveToolCommandDetailed（外部依赖，
    // 不受本文件 child_process mock 覆盖）。临时目录无 node_modules/.bin、码盾目录
    // 也无 eslint，故落到 PATH 探测 —— 真实 eslint 启动 ≈1s，全量并发时可能超默认 5s。
    // 与 fix(kernel): M2 画像裁剪测试加显式 60s 超时 同一处置。
  }, 20000);

  it('缺少 projectPath 上下文时显式报错，不静默回退 cwd', async () => {
    const adapter = new GuardESLintCheckAdapter();
    await expect(adapter.run({}, makeCheck())).rejects.toThrow(/缺少 projectPath/);
  });
});

describe('TestRunnerAdapter — 无测试脚本时跳过而不是阻断门禁', () => {
  it('package.json 没有 test 脚本 → warning / 不阻断 / 文案含「已跳过」', async () => {
    const dir = tempDirWith({
      'package.json': JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }),
    });
    const adapter = new TestRunnerAdapter();
    const check = makeBlockingTestCheck();

    const raw = await adapter.run({ repoRoot: dir }, check);
    const result = adapter.normalize(raw, {}, check);

    expect(result.status).toBe('warning');
    expect(result.severity).toBe('warning');
    // 这条是本次修复的核心：blocking 必须被压掉，否则「没配测试」会直接卡住提交
    expect(result.blocking).toBe(false);
    expect(result.message).toContain('已跳过');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('项目连 package.json 都没有 → 同样跳过', async () => {
    const dir = tempDirWith({ 'src/index.ts': 'export const a = 1;\n' });
    const adapter = new TestRunnerAdapter();
    const check = makeBlockingTestCheck();

    const raw = await adapter.run({ repoRoot: dir }, check);
    const result = adapter.normalize(raw, {}, check);

    expect(result.status).toBe('warning');
    expect(result.blocking).toBe(false);
  });

  it('package.json 损坏 → 仍是 error（这是真问题，不该被跳过吞掉）', async () => {
    const dir = tempDirWith({ 'package.json': '{ not json' });
    const adapter = new TestRunnerAdapter();
    const check = makeBlockingTestCheck();

    const raw = await adapter.run({ repoRoot: dir }, check);
    const result = adapter.normalize(raw, {}, check);

    expect(result.status).toBe('error');
  });
});
