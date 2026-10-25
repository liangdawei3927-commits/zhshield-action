import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DOMAIN_FULL_SCORE,
  scanTransition,
  shouldAutoEnterDetail,
  type ScanWatch,
} from '../hooks/scan-entry-logic';

/**
 * 扫描结束后「要不要自动进入详情页」—— 产品口径的唯一判据（纯函数 + 接线守卫）。
 *
 * 背景（2026-10-25 用户明确要求）：主页主按钮（一键体检 / 立即扫描 / 一键扫描 …）
 * 只负责**跑一次检查**，不负责**换页**。满分 100 停在主页，不满分才自动展开
 * 详情让用户看"哪里出了问题"。
 *
 * 这套判据最容易坏在三个地方，每条都对应一个用户能直接看见的错误：
 * 1) 把「报告非空」当「刚扫完」→ 页面一打开（读回落盘报告）就自动跳详情；
 * 2) 把「loading 下降沿」当「有新结论」→ 点「停止」也被推进详情；
 * 3) 满分也进详情 → 没有任何东西可看却换页，正是本次要根治的行为。
 */

describe('scan-entry-logic: shouldAutoEnterDetail', () => {
  it('满分（100）不进详情 —— 没有问题就别换页', () => {
    expect(shouldAutoEnterDetail({ score: 100, status: 'scored' })).toBe(false);
  });

  it('满分常量必须是 100（口径锚点，防止有人悄悄改）', () => {
    expect(DOMAIN_FULL_SCORE).toBe(100);
  });

  it('不满分进详情 —— 用户要看"哪里出了问题"', () => {
    expect(shouldAutoEnterDetail({ score: 99, status: 'scored' })).toBe(true);
    expect(shouldAutoEnterDetail({ score: 0, status: 'scored' })).toBe(true);
    expect(shouldAutoEnterDetail({ score: 43.5, status: 'scored' })).toBe(true);
  });

  it('判断不了就进详情（安全默认：宁可多给一次详情，不把问题藏在主页后）', () => {
    // 各种"拿不到分"的形态：IPC 返回 null、旧快照缺字段、非有限数
    expect(shouldAutoEnterDetail(null)).toBe(true);
    expect(shouldAutoEnterDetail(undefined)).toBe(true);
    expect(shouldAutoEnterDetail({ score: 100, status: 'not-run' })).toBe(true);
    expect(shouldAutoEnterDetail({ score: 100 })).toBe(true);
    expect(shouldAutoEnterDetail({ score: NaN, status: 'scored' })).toBe(true);
    expect(shouldAutoEnterDetail({ score: Infinity, status: 'scored' })).toBe(true);
  });
});

describe('scan-entry-logic: scanTransition', () => {
  const report = { total: 3 };

  it('上一刻在跑 + 这一刻停了 + 换了新报告 → finished', () => {
    const prev: ScanWatch = { loading: true, report: null };
    const next: ScanWatch = { loading: false, report };
    expect(scanTransition(prev, next)).toBe('finished');
  });

  it('上一刻没在跑 → 不算（页面挂载读回报告不是"刚扫完"）', () => {
    const prev: ScanWatch = { loading: false, report: null };
    const next: ScanWatch = { loading: false, report };
    expect(scanTransition(prev, next)).toBe('none');
  });

  it('还在跑 → 不算', () => {
    const prev: ScanWatch = { loading: true, report: null };
    const next: ScanWatch = { loading: true, report };
    expect(scanTransition(prev, next)).toBe('none');
  });

  it('停了但报告为空（失败/取消后清空）→ 没有新结论可看', () => {
    const prev: ScanWatch = { loading: true, report: null };
    expect(scanTransition(prev, { loading: false, report: null })).toBe('none');
  });

  it('停了但报告还是同一个对象（点「停止」保留旧结果）→ 不算新结论', () => {
    const prev: ScanWatch = { loading: true, report };
    const next: ScanWatch = { loading: false, report };
    expect(scanTransition(prev, next)).toBe('none');
  });
});

/**
 * 源码级守卫：**8 个分类页**都必须按同一口径接线。
 *
 * 「点主按钮先切详情再扫描」这类行为缺陷页面照样正常渲染，肉眼要等到
 * 某个域扫完才会发现被换了页。故按导航分类逐个核对消费点与主页 key。
 */
describe('scan-entry-logic: 接线完整性（源码级）', () => {
  const srcDir = path.resolve(__dirname, '..');
  const read = (f: string) => fs.readFileSync(path.join(srcDir, f), 'utf-8');

  /** 自己持有 showHome、直接调 useScanResultEntry 的四页 */
  const directConsumers: Record<string, string> = {
    inspect: 'pages/InspectPage.tsx',
    guard: 'pages/GuardPage.tsx',
    security: 'pages/SecurityPage.tsx',
    refactor: 'pages/RefactorPage.tsx',
  };
  /** 走 useDomainDetailPage、由共享 hook 统一判定的四页 */
  const hookDriven: Record<string, string> = {
    deps: 'pages/DependencyPage.tsx',
    garbage: 'pages/GarbagePage.tsx',
    performance: 'pages/PerformancePage.tsx',
    techdebt: 'pages/TechDebtPage.tsx',
  };

  it('四个自持视图状态的页面各自接上判据 hook，且主页 Provider 带重挂载 key', () => {
    const offenders = Object.entries(directConsumers).filter(([id, file]) => {
      const src = read(file);
      return (
        !src.includes(`navId: '${id}'`) ||
        !src.includes('useScanResultEntry(') ||
        // 主页分支必须以 scanVersion 为 key：扫完不进详情时评分环才会刷新
        !/key=\{(scanVersion|state\.scanVersion|detail\.scanVersion)\}/.test(src)
      );
    });
    expect(offenders).toEqual([]);
  });

  it('四个 hook 驱动的页面主页同样带 scanVersion key（key 由共享 hook 提供）', () => {
    const hookSrc = read('hooks/useDomainDetailEntry.ts');
    // 共享 hook 必须真的消费判据，四个页面才能什么都不写就享受同一口径
    expect(hookSrc).toContain('useScanResultEntry(');
    expect(hookSrc).toContain('scanVersion');

    const offenders = Object.values(hookDriven).filter(
      (file) => !/key=\{detail\.scanVersion\}/.test(read(file)),
    );
    expect(offenders).toEqual([]);
  });

  it('「开始扫描」不得再先切详情 —— 主按钮只跑检查，不换页', () => {
    // 共享 hook 的 startScan 是四个页面的唯一入口：它若先 setShowHome(false)，
    // 满分场景照样被扔进详情页。切片到 startScan 的实现行核对。
    const hookSrc = read('hooks/useDomainDetailEntry.ts');
    const at = hookSrc.indexOf('const startScan = useCallback(');
    expect(at).toBeGreaterThanOrEqual(0);
    const impl = hookSrc.slice(at, at + 200);
    expect(impl).not.toContain('setShowHome(false)');

    // 体检页同样自己持有 startScan，核对它不切视图
    const inspectSrc = read('pages/InspectPage.tsx');
    const inspectAt = inspectSrc.indexOf('const startScan = () =>');
    expect(inspectAt).toBeGreaterThanOrEqual(0);
    expect(inspectSrc.slice(inspectAt, inspectAt + 120)).not.toContain('setShowHome(false)');
  });
});
