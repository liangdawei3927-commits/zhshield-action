import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuleEngineReport } from '@zh/kernel';
import { runGuardDomain } from '../domains/executors';
import { domainSnapshotPath, type DiagnosticsReport } from '../domain-snapshot';

/**
 * 门禁读结论的**根**（《07》O8 / C3 的一次真实回归）。
 *
 * 事故：用户打开的是外层容器目录（无 package.json），代码在内层 monorepo。
 * `PipelineRunner` 按「容器目录下探」把 `repoRoot` 解析到内层，而各域快照由
 * 桌面端写在**用户打开的项目**下。门禁若用 `repoRoot` 读，就会拿到内层仓库
 * 自己那份旧快照 —— 2026-11-09 实测：deps 2026-09-21（1 条 error）、
 * inspect 2026-10-19（1 条 error），门禁因此报出三个早已修复的「拦截」。
 *
 * 这里锁的是「读哪个根」，不是快照解析细节：
 *   · runner 提供 `projectPath`（状态根）→ 必须读它；
 *   · 未提供（存量实现）→ 回退 `repoRoot`，不得读空。
 */

const emptyReport = (): RuleEngineReport => ({
  total: 1,
  passed: 1,
  failed: 0,
  errors: 0,
  skipped: 0,
  degraded: 0,
  ok: true,
  blockingCount: 0,
  evaluations: [],
  durationMs: 0,
  timestamp: new Date(),
});

function makeReport(
  projectPath: string,
  generatedAt: string,
  issues: DiagnosticsReport['issues'],
): DiagnosticsReport {
  return {
    version: '1.0',
    project: { path: projectPath, name: 'demo' },
    generatedAt,
    summary: {
      total: issues.length,
      error: issues.filter((issue) => issue.severity === 'error').length,
      warning: issues.filter((issue) => issue.severity === 'warning').length,
      info: issues.filter((issue) => issue.severity === 'info').length,
    },
    issues,
    files: [],
  };
}

async function writeSnapshot(
  projectPath: string,
  source: 'inspect' | 'security' | 'deps',
  report: DiagnosticsReport,
): Promise<void> {
  await mkdir(join(projectPath, '.zhshield', 'diagnostics', 'domains'), { recursive: true });
  await writeFile(domainSnapshotPath(projectPath, source), JSON.stringify(report), 'utf-8');
}

describe('runGuardDomain — 结论集从状态根读取', () => {
  let opened: string;
  let nested: string;

  beforeEach(async () => {
    opened = await mkdtemp(join(tmpdir(), 'zhshield-state-root-opened-'));
    nested = join(opened, 'nested-repo');
    await mkdir(nested, { recursive: true });
  });

  afterEach(async () => {
    await rm(opened, { recursive: true, force: true });
  });

  it('Given 打开容器目录、扫描根下探到嵌套仓库，When 跑门禁域，Then 读打开项目的新快照', async () => {
    // 打开的项目（状态根）：deps 干净，快照时间新
    await writeSnapshot(opened, 'deps', makeReport(opened, '2026-11-08T00:00:00.000Z', []));
    // 嵌套仓库（扫描根）：deps 有 1 条 error，快照是两个月前的旧结论
    await writeSnapshot(
      nested,
      'deps',
      makeReport(nested, '2026-09-21T17:50:58.122Z', [
        {
          ruleId: 'env:node',
          severity: 'error',
          category: 'deps',
          message: '旧快照里的 Node 版本不一致',
          file: '',
          autoFixable: false,
          fingerprint: 'fp-stale',
          source: 'deps',
        },
      ]),
    );

    let captured: {
      conclusions?: Record<string, { generatedAt: string; issues: readonly unknown[] }>;
    } = {};
    const runner = {
      repoRoot: nested,
      runSopInspect: async () => emptyReport(),
      runSopGuard: async (context?: unknown) => {
        captured = (context ?? {}) as typeof captured;
        return emptyReport();
      },
    };

    await runGuardDomain({ repoRoot: nested, stateRoot: opened, runner });

    expect(captured.conclusions?.deps?.generatedAt).toBe('2026-11-08T00:00:00.000Z');
    expect(captured.conclusions?.deps?.issues).toEqual([]);
  });

  it('Given 未提供 stateRoot（无头/存量调用方），When 跑门禁域，Then 回退 repoRoot', async () => {
    await writeSnapshot(
      nested,
      'deps',
      makeReport(nested, '2026-11-07T00:00:00.000Z', []),
    );

    let captured: { conclusions?: Record<string, { generatedAt: string }> } = {};
    const runner = {
      repoRoot: nested,
      runSopInspect: async () => emptyReport(),
      runSopGuard: async (context?: unknown) => {
        captured = (context ?? {}) as typeof captured;
        return emptyReport();
      },
    };

    await runGuardDomain({ repoRoot: nested, runner });

    expect(captured.conclusions?.deps?.generatedAt).toBe('2026-11-07T00:00:00.000Z');
  });
});
