import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PipelineRunner } from '@zh/pipeline';
import type { ConsoleReporter } from '@zh/reporter';
import type { CLIOptions } from '../cli-options';
import { runGuardCommand, runInspectCommand } from '../commands';

// 本文件验证 --format/--report 的机器可读报告落盘契约：
// CI（GitHub Action）依赖 SARIF/JSON 产物上传 Security 面板与状态检查，
// 文件名、路径解析、SARIF 中的仓库相对路径任何一处漂移都会让产物链路静默断掉。

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code ?? 0})`);
  }
}

function stubProcessExit(): void {
  vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    throw new ExitSignal(code == null ? undefined : Number(code));
  });
}

/** 驱动一个会以 process.exit 终止的命令，归还其退出码（undefined 视为 0） */
async function exitCodeOf(fn: () => Promise<void>): Promise<number | undefined> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
  throw new Error('命令未按契约调用 process.exit');
}

function makeOpts(overrides: Partial<CLIOptions>): CLIOptions {
  return {
    command: 'guard',
    dir: '',
    dryRun: true, // 落盘测试统一用 dry-run，让「是否阻断」与「是否写文件」解耦
    sop: false,
    verbose: false,
    color: false,
    help: false,
    format: 'text',
    report: '',
    failOn: 'error',
    ...overrides,
  };
}

function makeRunner(runGuardImpl: () => Promise<unknown>): PipelineRunner {
  return { runGuard: vi.fn(runGuardImpl) } as unknown as PipelineRunner;
}
function makeReporter() {
  return { format: vi.fn(() => ({ text: 'TEXT', passed: true })) };
}

/** 带绝对路径违规的 GuardReport：验证 SARIF 中路径必须相对化（GitHub Code Scanning 硬性要求） */
function makeGuardReportWithViolation(projectDir: string) {
  return {
    ok: false,
    mode: 'guard',
    target: projectDir,
    timestamp: new Date(),
    summary: { total: 1, passed: 0, failed: 1 },
    results: [
      {
        checkId: 'guard.chk.secret',
        status: 'failed',
        severity: 'error',
        message: '存在硬编码密钥',
        details: {
          violations: [
            {
              ruleId: 'secret.hardcoded-key',
              severity: 'critical',
              message: '发现 API Key',
              file: path.join(projectDir, 'src', 'a.ts'),
              line: 7,
              column: 1,
            },
          ],
        },
      },
    ],
  };
}

describe('runGuardCommand — 机器可读报告落盘（--format/--report）', () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    stubProcessExit();
    process.exitCode = undefined;
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function makeTmpProject(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-cli-report-'));
  }

  it('Given --format json，When guard，Then 写入独立默认名 zhshield-guard.json（不与 inspect/refactor 报告互相覆盖）', async () => {
    const projectDir = makeTmpProject();
    try {
      const report = makeGuardReportWithViolation(projectDir);
      await exitCodeOf(() =>
        runGuardCommand(
          makeRunner(async () => report),
          makeOpts({ format: 'json' }),
          makeReporter() as unknown as ConsoleReporter,
          projectDir,
        ),
      );

      const outPath = path.join(projectDir, 'zhshield-guard.json');
      expect(fs.existsSync(outPath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as { results: Array<{ checkId: string }> };
      expect(parsed.results[0].checkId).toBe('guard.chk.secret');
      expect(errors.join('\n')).toContain('报告已写入');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('Given --format json，When inspect，Then 仍写 zhshield.json（MCP 首次引导回退读取该文件，不可改名）', async () => {
    const projectDir = makeTmpProject();
    try {
      const report = {
        ok: true,
        issues: [],
        summary: { total: 0, error: 0, warning: 0, info: 0 },
        score: 100,
        grade: 'A',
        totalFiles: 0,
      };
      const runner = { runInspect: vi.fn(async () => report) } as unknown as PipelineRunner;
      await exitCodeOf(() =>
        runInspectCommand(
          runner,
          makeOpts({ command: 'inspect', format: 'json' }),
          makeReporter() as unknown as ConsoleReporter,
          projectDir,
        ),
      );

      expect(fs.existsSync(path.join(projectDir, 'zhshield.json'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'zhshield-guard.json'))).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('Given --format json --report 自定义相对路径，When guard，Then 按 projectDir 解析写入该路径', async () => {
    const projectDir = makeTmpProject();
    try {
      fs.mkdirSync(path.join(projectDir, 'build-out'));
      await exitCodeOf(() =>
        runGuardCommand(
          makeRunner(async () => makeGuardReportWithViolation(projectDir)),
          makeOpts({ format: 'json', report: 'build-out/custom.json' }),
          makeReporter() as unknown as ConsoleReporter,
          projectDir,
        ),
      );

      expect(fs.existsSync(path.join(projectDir, 'build-out', 'custom.json'))).toBe(true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('Given --report 指向不存在的父目录，When guard，Then 自动逐级创建父目录后写入——CI 传 reports/xxx.json 不应因目录未预建而裸抛 ENOENT', async () => {
    const projectDir = makeTmpProject();
    try {
      await exitCodeOf(() =>
        runGuardCommand(
          makeRunner(async () => makeGuardReportWithViolation(projectDir)),
          makeOpts({ format: 'json', report: 'reports/deep/zhshield.json' }),
          makeReporter() as unknown as ConsoleReporter,
          projectDir,
        ),
      );

      expect(fs.existsSync(path.join(projectDir, 'reports', 'deep', 'zhshield.json'))).toBe(true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('Given --format sarif，When guard，Then 写入合法 SARIF：tool 名、results 与仓库相对路径齐全', async () => {
    const projectDir = makeTmpProject();
    try {
      await exitCodeOf(() =>
        runGuardCommand(
          makeRunner(async () => makeGuardReportWithViolation(projectDir)),
          makeOpts({ format: 'sarif' }),
          makeReporter() as unknown as ConsoleReporter,
          projectDir,
        ),
      );

      const outPath = path.join(projectDir, 'zhshield-guard.sarif');
      expect(fs.existsSync(outPath)).toBe(true);
      const sarif = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as {
        version: string;
        runs: Array<{
          tool: { driver: { name: string } };
          results: Array<{
            ruleId: string;
            level: string;
            locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
          }>;
        }>;
      };
      expect(sarif.version).toBe('2.1.0');
      expect(sarif.runs[0].tool.driver.name).toBe('zhshield');
      expect(sarif.runs[0].results[0].ruleId).toBe('secret.hardcoded-key');
      expect(sarif.runs[0].results[0].level).toBe('error');
      // 引擎产出的是绝对路径，SARIF 必须相对化到项目根，否则 GitHub 无法映射到仓库文件
      expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe(
        path.join('src', 'a.ts'),
      );
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('Given --format text（默认），When guard，Then 不写任何机器可读文件——避免在用户项目里留下意外产物', async () => {
    const projectDir = makeTmpProject();
    try {
      await exitCodeOf(() =>
        runGuardCommand(
          makeRunner(async () => makeGuardReportWithViolation(projectDir)),
          makeOpts({ format: 'text' }),
          makeReporter() as unknown as ConsoleReporter,
          projectDir,
        ),
      );

      const leftovers = fs.readdirSync(projectDir);
      expect(leftovers).toHaveLength(0);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

/** SOP 分支产出 RuleEngineReport：evaluations + ok 是 reporter 识别该 schema 的键 */
function makeSopReport() {
  return {
    ok: true,
    total: 0,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    degraded: 0,
    blockingCount: 0,
    evaluations: [],
    durationMs: 0,
    timestamp: new Date(),
  };
}

/** --sop 分支的 runner：必须同时具备 runSop* 与后置门禁入口（finalizeScan 必然调用后者） */
function makeSopRunner(runSopImpl: () => Promise<unknown>, isGuard: boolean): PipelineRunner {
  const runner: Record<string, unknown> = {
    evaluatePostScanGates: vi.fn(() => ({ total: 0, failed: 0, undetermined: 0 })),
  };
  runner[isGuard ? 'runSopGuard' : 'runSopInspect'] = vi.fn(runSopImpl);
  return runner as unknown as PipelineRunner;
}

function makeSopReporter() {
  return {
    format: vi.fn(() => ({ text: 'TEXT', passed: true })),
    formatRuleEngine: vi.fn(() => ({ text: 'SOP', passed: true })),
  };
}

describe('--sop 分支 — 报告文件必须与默认路径分开（两套 schema 不得同文件）', () => {
  let errors: string[];

  beforeEach(() => {
    stubProcessExit();
    process.exitCode = undefined;
    errors = [];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function makeTmpProject(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-cli-sop-report-'));
  }

  it('Given --sop --format json，When inspect，Then 写 zhshield-sop.json 且不产生/覆盖 zhshield.json', async () => {
    const projectDir = makeTmpProject();
    try {
      await exitCodeOf(() =>
        runInspectCommand(
          makeSopRunner(async () => makeSopReport(), false),
          makeOpts({ command: 'inspect', sop: true, format: 'json', dryRun: false }),
          makeSopReporter() as unknown as ConsoleReporter,
          projectDir,
        ),
      );

      const sopPath = path.join(projectDir, 'zhshield-sop.json');
      expect(fs.existsSync(sopPath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(sopPath, 'utf-8')) as { evaluations?: unknown };
      expect(Array.isArray(parsed.evaluations)).toBe(true);
      // zhshield.json 是 MCP 首次引导回退读取的巡检报告（issues schema），不得被 SOP 报告占用
      expect(fs.existsSync(path.join(projectDir, 'zhshield.json'))).toBe(false);
      expect(errors.join('\n')).toContain('zhshield-sop.json');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('Given --sop --format json，When guard，Then 写 zhshield-guard-sop.json 且不产生/覆盖 zhshield-guard.json', async () => {
    const projectDir = makeTmpProject();
    try {
      await exitCodeOf(() =>
        runGuardCommand(
          makeSopRunner(async () => makeSopReport(), true),
          makeOpts({ command: 'guard', sop: true, format: 'json' }),
          makeSopReporter() as unknown as ConsoleReporter,
          projectDir,
        ),
      );

      expect(fs.existsSync(path.join(projectDir, 'zhshield-guard-sop.json'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'zhshield-guard.json'))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, 'zhshield.json'))).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
