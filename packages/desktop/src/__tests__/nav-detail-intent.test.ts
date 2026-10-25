import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DETAIL_INTENT_TTL_MS,
  peekDetailIntent,
  requestDetailIntent,
  resetDetailIntent,
  shouldTakeIntent,
  takeDetailIntent,
} from '../hooks/nav-detail-intent';
import { navItems } from '../components/layout/nav-items';

/**
 * 跨页「直达详情」意图 —— 任务中心的归属页入口点进来要直接看到结果，而不是落在主页。
 *
 * 背景：分类页统一「打开先落在主页」（历史结果只让详情入口可见）。归属页入口
 * 的语义不是「逛分类」，而是「看这条任务」。若它只做普通导航，用户点完还得再点
 * 一次右上角详情图标 —— 动作被拆成两步。
 *
 * 这套交接条最容易坏在三个地方，每条都对应一个用户能直接看见的错误：
 * 1) 不带页归属 → 点了进度条又改点侧边栏，无关页面被推进详情；
 * 2) 取走不清 → 切项目 / 重挂载时页面又莫名跳详情；
 * 3) 不限时 → 导航被拦时意图滞留，几分钟后正常点进该分类会被弹进详情。
 */

beforeEach(() => resetDetailIntent());

describe('nav-detail-intent: 一次性交接', () => {
  it('没有请求时不取', () => {
    expect(takeDetailIntent('guard')).toBe(false);
    expect(peekDetailIntent()).toBeNull();
  });

  it('只有目标页能取走，且取走即清（不重复消费）', () => {
    requestDetailIntent('guard', 1000);
    // 别的页取不走，也不该把它清掉（否则用户改道后原目标就收不到了）
    expect(takeDetailIntent('sentinel', 1000)).toBe(false);
    expect(peekDetailIntent()?.page).toBe('guard');

    expect(takeDetailIntent('guard', 1000)).toBe(true);
    expect(peekDetailIntent()).toBeNull();
    expect(takeDetailIntent('guard', 1000)).toBe(false);
  });

  it('后一次请求覆盖前一次（意图只服务最近一次点击）', () => {
    requestDetailIntent('guard', 1000);
    requestDetailIntent('security', 1001);
    expect(takeDetailIntent('guard', 1001)).toBe(false);
    expect(takeDetailIntent('security', 1001)).toBe(true);
  });

  it('超过 TTL 视为过期，且过期项被顺手清掉', () => {
    requestDetailIntent('guard', 1000);
    expect(takeDetailIntent('guard', 1000 + DETAIL_INTENT_TTL_MS + 1)).toBe(false);
    expect(peekDetailIntent()).toBeNull();
  });

  it('时钟回拨（age 为负）按过期处理 —— 宁可落主页也不误跳详情', () => {
    requestDetailIntent('guard', 5000);
    expect(shouldTakeIntent({ page: 'guard', at: 5000 }, 'guard', 4000)).toBe(false);
    expect(takeDetailIntent('guard', 4000)).toBe(false);
  });
});

/**
 * 源码级守卫：**每个能从进度条跳过去的分类**都必须接上意图通道。
 *
 * 这类「接线漏一根」的缺陷不会被行为测试抓到 —— 页面照样正常渲染，只是少了
 * 那一步直达，肉眼要等到某个域跑完才知道。故按导航定义逐个核对消费点。
 */
describe('nav-detail-intent: 接线完整性（源码级）', () => {
  const pagesDir = path.resolve(__dirname, '../pages');
  const readPage = (f: string) => fs.readFileSync(path.join(pagesDir, f), 'utf-8');

  /** 自己持有 showHome、在页面内直接消费意图的四页 */
  const directConsumers: Record<string, string> = {
    inspect: 'InspectPage.tsx',
    guard: 'GuardPage.tsx',
    security: 'SecurityPage.tsx',
    refactor: 'RefactorPage.tsx',
  };
  /** 走 useDomainDetailPage、由该 hook 内部消费的四页（域键 = 导航 id） */
  const hookDriven: Record<string, string> = {
    deps: 'DependencyPage.tsx',
    garbage: 'GarbagePage.tsx',
    performance: 'PerformancePage.tsx',
    techdebt: 'TechDebtPage.tsx',
  };

  const reachable = navItems.filter((item) => item.scanProgress !== undefined).map((i) => i.id);

  it('可跳转分类集合与消费点集合完全一致（不多不少）', () => {
    // 进度条只能跳到有 scanProgress 的分类（navIdForTaskKind 的判据）
    expect(reachable.sort()).toEqual([...Object.keys(directConsumers), ...Object.keys(hookDriven)].sort());
    // 真阳性计数：确实有 8 个分类可达，防止过滤条件写错导致下面的断言空跑
    expect(reachable.length).toBe(8);
  });

  it('四个自持视图状态的页面各自消费了本页意图', () => {
    const missing = Object.entries(directConsumers).filter(
      ([id, file]) => !readPage(file).includes(`useDetailIntentEffect('${id}'`),
    );
    expect(missing).toEqual([]);
  });

  it('四个 hook 驱动的页面，域键必须等于导航 id（否则取不到意图）', () => {
    const offenders = Object.entries(hookDriven).filter(([id, file]) => {
      const src = readPage(file);
      // 入参为对象字面量（跨行）：取调用点切片再校验 domain 字段，不绑死格式
      const callAt = src.indexOf('useDomainDetailPage({');
      return callAt < 0 || !src.slice(callAt, callAt + 300).includes(`domain: '${id}'`);
    });
    expect(offenders).toEqual([]);
    // hook 内部必须真的把 navId 交给意图通道
    const hookSrc = fs.readFileSync(
      path.resolve(__dirname, '../hooks/useDomainDetailEntry.ts'),
      'utf-8',
    );
    expect(hookSrc).toContain('useDetailIntentEffect(navId');
  });

  // 原有一条「全局进度条点击同时『登记意图 + 导航』」：右下角 GlobalScanIndicator
  // 已于 2026-10-26 下线（用户明确不要该浮窗），随之删除，不再保留源码级断言。
});
