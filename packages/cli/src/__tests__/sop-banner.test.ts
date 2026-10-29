import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PipelineRunner } from '@zh/pipeline';

import {
  REQUIRE_SOP_ENV,
  clearSopSourceSummary,
  finalizeScan,
  formatSopSourceBanner,
  isRequireSop,
  reportPostScanGates,
  setSopSourceSummary,
} from '../sop-banner';
import type { SopSourceSummary } from '../sop-banner';
import type { PostScanGateReport } from '@zh/pipeline';

/**
 * 「门禁到底判了没有」的出口契约。
 *
 * 本轮修的两个失真都在这层：
 *   ① `total === 0` 曾直接 return ⇒「一条门禁规则都没加载」与「门禁全达标」打印完全一样；
 *   ② 门禁判定曾写在命令 return 之后 ⇒ 命令 process.exit 后是死代码，只在 mock 里「通过」。
 * 所以下面每条用例都盯"用户能不能分辨"，而不是"函数返回值对不对"。
 */

function summary(overrides: Partial<SopSourceSummary> = {}): SopSourceSummary {
  return {
    bundled: 43,
    synced: 52,
    total: 95,
    active: 62,
    cache: { dir: '/cache', origin: '桌面端云同步缓存' },
    freshness: { fileCount: 4 },
    ...overrides,
  };
}

function gateReport(overrides: Partial<PostScanGateReport> = {}): PostScanGateReport {
  return {
    total: 2,
    passed: 2,
    failed: 0,
    undetermined: 0,
    blockingFailed: 0,
    blockingUndetermined: 0,
    ok: true,
    complete: true,
    items: [],
    ...overrides,
  };
}

function fakeRunner(report: PostScanGateReport): PipelineRunner {
  return { evaluatePostScanGates: () => report } as unknown as PipelineRunner;
}

describe('formatSopSourceBanner — 规则从哪来', () => {
  it('Given 云端已装载，Then 同时报注册总数与两源条数——只报"已加载 N 条"无法分辨云端进没进来', () => {
    const lines = formatSopSourceBanner(summary()).join('\n');
    expect(lines).toContain('SOP 规则注册 95 条');
    expect(lines).toContain('内置模板 43 条');
    expect(lines).toContain('云端同步 52 条');
    expect(lines).toContain('桌面端云同步缓存');
  });

  it('Given 两源相加不等于注册数（有重复 id 被云端覆盖），Then 明确说明合并规则——数字对不上而不解释等于让用户怀疑统计', () => {
    const lines = formatSopSourceBanner(summary({ bundled: 43, synced: 52, total: 90 })).join('\n');
    expect(lines).toContain('以云端为准');
  });

  it('Given 云端未装载，Then 打 0 条并给出具体原因——"0 条"不带原因会让人以为云端本来就没有规则', () => {
    const lines = formatSopSourceBanner(
      summary({
        synced: 0,
        cache: { origin: '桌面端云同步缓存', reason: '未找到 /x/modules' },
      }),
    ).join('\n');
    expect(lines).toContain('云端同步 0 条');
    expect(lines).toContain('未找到 /x/modules');
  });

  it('Given 缓存超过 7 天，Then 提示阈值可能过期——用一周前的规则判今天的代码属合法失真', () => {
    const lines = formatSopSourceBanner(
      summary({
        freshness: {
          fileCount: 4,
          updatedAt: new Date('2026-10-01T00:00:00'),
          ageMs: 30 * 86_400_000,
        },
      }),
    ).join('\n');
    expect(lines).toContain('30 天未更新');
  });

  it('Given 缓存 1 天内，Then 不出现过期提示——天天响的警告等于没警告', () => {
    const lines = formatSopSourceBanner(
      summary({
        freshness: {
          fileCount: 4,
          updatedAt: new Date('2026-10-29T00:00:00'),
          ageMs: 3 * 3_600_000,
        },
      }),
    ).join('\n');
    expect(lines).not.toContain('未更新');
    expect(lines).toContain('3 小时前');
  });
});

describe('reportPostScanGates — 没有结论 ≠ 通过', () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    clearSopSourceSummary();
  });

  afterEach(() => {
    clearSopSourceSummary();
  });

  const log = (line: string): void => {
    lines.push(line);
  };

  it('Given 门禁全部达标，Then 明说"全部达标"——绿灯要有实词，不能只是安静退出', () => {
    setSopSourceSummary(summary());
    const outcome = reportPostScanGates(fakeRunner(gateReport()), log);
    expect(outcome.exitCode).toBeUndefined();
    expect(lines.join('\n')).toContain('全部 2 项达标');
  });

  it('Given 有门禁未达标，Then 阻断 exit 1——这是门禁的本职，不是提示', () => {
    setSopSourceSummary(summary());
    const outcome = reportPostScanGates(
      fakeRunner(
        gateReport({
          total: 2,
          passed: 1,
          failed: 1,
          blockingFailed: 1,
          ok: false,
          complete: true,
        }),
      ),
      log,
    );
    expect(outcome.exitCode).toBe(1);
    expect(lines.join('\n')).toContain('未达标 — 阻断');
  });

  it('Given 门禁未判定（CLI 拿不到健康分），Then 明确"不算通过"但**不**阻断——缺数据不等于代码有问题', () => {
    setSopSourceSummary(summary());
    const outcome = reportPostScanGates(
      fakeRunner(
        gateReport({
          total: 2,
          passed: 1,
          undetermined: 1,
          blockingUndetermined: 1,
          ok: false,
          complete: false,
        }),
      ),
      log,
    );
    expect(outcome.exitCode).toBeUndefined();
    expect(lines.join('\n')).toContain('未判定（缺数据源，不算通过）');
  });

  it('Given 一条门禁规则都没加载但云端规则在，Then 说明"本次规则集不含门禁规则"且不阻断——云端确实没下发门禁，不是环境问题', () => {
    setSopSourceSummary(summary());
    const outcome = reportPostScanGates(fakeRunner(gateReport({ total: 0, passed: 0 })), log);
    expect(outcome.exitCode).toBeUndefined();
    const text = lines.join('\n');
    expect(text).toContain('不含扫描后门禁规则');
    expect(text).toContain('不代表通过');
  });

  it('Given 云端规则没加载导致门禁为空，Then 必须点明"没有任何门禁结论"——这正是 pre-commit 假绿的成因', () => {
    setSopSourceSummary(
      summary({ synced: 0, cache: { origin: '桌面端云同步缓存', reason: '未找到 /x/modules' } }),
    );
    const outcome = reportPostScanGates(fakeRunner(gateReport({ total: 0, passed: 0 })), log);
    const text = lines.join('\n');
    expect(text).toContain('未加载云端规则');
    expect(text).toContain('未找到 /x/modules');
    expect(text).toContain('empty ≠ passed');
    // 宽松模式不阻断，但必须给出打开开关的办法
    expect(outcome.exitCode).toBeUndefined();
    expect(text).toContain(REQUIRE_SOP_ENV);
  });

  it('Given 云端规则没加载且开了 REQUIRE_SOP，Then exit 2——CI 想要真空门禁时的唯一升级路径', () => {
    setSopSourceSummary(
      summary({ synced: 0, cache: { origin: '桌面端云同步缓存', reason: '未找到 /x/modules' } }),
    );
    const outcome = reportPostScanGates(
      fakeRunner(gateReport({ total: 0, passed: 0 })),
      log,
      { [REQUIRE_SOP_ENV]: '1' },
    );
    expect(outcome.exitCode).toBe(2);
    expect(lines.join('\n')).toContain('环境不完整');
  });

  it('Given 未注入装载上下文（单测直接驱动命令），Then 按"云端未加载"保守处理——不知道来源时不能说门禁通过', () => {
    const outcome = reportPostScanGates(fakeRunner(gateReport({ total: 0, passed: 0 })), log);
    expect(lines.join('\n')).toContain('未注入规则装载上下文');
    expect(outcome.exitCode).toBeUndefined();
  });
});

describe('isRequireSop — 开关解析', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['YES', true],
    [' 1 ', true],
    ['0', false],
    ['', false],
    [undefined, false],
  ])('Given %s，Then %s', (value, expected) => {
    expect(isRequireSop(value === undefined ? {} : { [REQUIRE_SOP_ENV]: value })).toBe(expected);
  });
});

describe('finalizeScan — 退出码优先级', () => {
  let lines: string[];
  let exited: Array<number | string | undefined>;

  beforeEach(() => {
    lines = [];
    exited = [];
    clearSopSourceSummary();
    process.exitCode = undefined;
  });

  afterEach(() => {
    clearSopSourceSummary();
    process.exitCode = undefined;
  });

  const exit = (code?: number | string): never => {
    exited.push(code);
    throw new Error(`exit:${String(code)}`);
  };

  const run = (report: PostScanGateReport, blocked: boolean, sop = true): void => {
    try {
      finalizeScan(fakeRunner(report), { sop }, blocked, exit, (line) => lines.push(line));
    } catch {
      // exit 的哨兵异常，正常路径
    }
  };

  it('Given 违规阻断，Then 直接 exit 1——违规优先于门禁结论', () => {
    setSopSourceSummary(summary());
    run(gateReport({ total: 0, passed: 0 }), true);
    expect(exited).toEqual([1]);
  });

  it('Given 已由降级护栏设了 exitCode=2，Then 保持 2 不被门禁覆盖——环境不完整比单条阈值更严重', () => {
    setSopSourceSummary(summary());
    process.exitCode = 2;
    run(gateReport({ total: 0, passed: 0 }), false);
    expect(exited).toEqual([2]);
  });

  it('Given 门禁未达标且无其它退出码，Then exit 1', () => {
    setSopSourceSummary(summary());
    run(gateReport({ total: 1, passed: 0, failed: 1, blockingFailed: 1, ok: false }), false);
    expect(exited).toEqual([1]);
  });

  it('Given 未开 --sop，Then 完全不判门禁——不做 SOP 的扫描不该被 SOP 门禁阻断', () => {
    setSopSourceSummary(summary());
    run(gateReport({ total: 1, passed: 0, failed: 1, blockingFailed: 1, ok: false }), false, false);
    expect(exited).toEqual([undefined]);
    expect(lines).toEqual([]);
  });

  it('Given 门禁全达标，Then exit undefined（等价 0）', () => {
    setSopSourceSummary(summary());
    run(gateReport(), false);
    expect(exited).toEqual([undefined]);
  });
});
