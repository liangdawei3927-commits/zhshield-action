/**
 * 顶部导航 12 功能 · 阶段B（v2）：一项一实例，真实触发核心动作
 *
 * 相比 v1 的修正：
 *   1. 每个功能独立启动一个 Electron 实例 —— 避免上一页的扫描任务排队串扰下一页
 *   2. 主动作按「候选标签」匹配 —— 页面在空态/有数据/自动开扫三种状态下按钮文案不同
 *   3. 完成判定 = 任务管理器无 running/queued + 无进行中文案 + 文本稳定
 *
 * 扫描对象 = $ZH_NAV_FIXTURE（默认 /tmp/zh-nav-fixture，内含 7 类已知缺陷）。
 * 可只跑子集：ZH_NAV_ONLY=inspect,guard
 *
 * 运行：ZH_NAV_FIXTURE=/tmp/zh-nav-fixture pnpm exec playwright test e2e/nav-actions.spec.ts
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ENTRIES, SHOT_DIR, entryButton, launchApp, mainText } from './nav-helpers';

/** 每项功能的主动作候选按钮标签（按顺序尝试）；键必须与 nav-helpers 的 ENTRIES.id 对齐 */
const ACTION_CANDIDATES: Record<string, string[]> = {
  inspect: ['马上巡检', '重新巡检'],
  guard: ['立即扫描', '重新扫描'],
  sentinel: ['启动监控', '监控运行中'],
  security: ['一键扫描', '重新检查', '开始扫描'],
  deps: ['开始盘点', '重新盘点'],
  garbage: ['开始扫描', '重新扫描'],
  performance: ['开始性能检测', '重新检测'],
  techdebt: ['开始盘点', '重新盘点'],
  refactor: ['马上检查', '重新检查'],
  reports: ['汇总生成报告', '📊 汇总生成报告', '重新汇总'],
  evolve: ['架构分析', '刷新'],
  backup: ['一键备份'],
};

const BUSY = [
  '扫描中',
  '检测中',
  '盘点中',
  '巡检中',
  '备份中',
  '分析中',
  '候检',
  '检查中',
  '加载',
  '排队中',
  '正在',
];

async function runningTasks(page: Page): Promise<number> {
  try {
    const list = (await page.evaluate(async () => {
      const api = (window as unknown as { electronAPI?: { tasks?: { list?: () => Promise<unknown[]> } } })
        .electronAPI;
      if (!api?.tasks?.list) return [] as Array<{ status?: string }>;
      return (await api.tasks.list()) as Array<{ status?: string }>;
    })) as Array<{ status?: string }>;
    return (list ?? []).filter((t) => t.status === 'running' || t.status === 'queued').length;
  } catch {
    return 0;
  }
}

/** 安静判定：无 running/queued 任务 + 无进行中文案 + 文本连续 quietMs 未变 */
async function waitSettled(
  page: Page,
  maxMs = 300_000,
  quietMs = 6_000,
): Promise<{ settled: boolean; elapsed: number; runningAtEnd: number }> {
  const t0 = Date.now();
  let last = '';
  let lastChange = Date.now();
  let running = 0;
  while (Date.now() - t0 < maxMs) {
    const txt = await mainText(page).catch(() => '');
    running = await runningTasks(page);
    const busy = BUSY.some((b) => txt.includes(b));
    if (txt !== last) {
      last = txt;
      lastChange = Date.now();
    }
    if (!busy && running === 0 && Date.now() - lastChange >= quietMs) {
      return { settled: true, elapsed: Date.now() - t0, runningAtEnd: running };
    }
    await page.waitForTimeout(2000);
  }
  return { settled: false, elapsed: Date.now() - t0, runningAtEnd: running };
}

const ONLY = (process.env.ZH_NAV_ONLY ?? '').split(',').filter(Boolean);
const TARGETS = ONLY.length ? ENTRIES.filter((e) => ONLY.includes(e.id)) : ENTRIES;

test.describe('顶部导航 12 功能 · 真实动作验证（一项一实例）', () => {
  test.setTimeout(30 * 60_000);

  for (const e of TARGETS) {
    test(`[${e.id}] ${e.label} → ${e.action}`, async () => {
      mkdirSync(SHOT_DIR, { recursive: true });
      const { app, page, errors } = await launchApp();
      const rec: Record<string, unknown> = { id: e.id, label: e.label, action: e.action };
      try {
        await entryButton(page, e).click({ timeout: 20_000 });
        await page.waitForTimeout(1500);
        const before = await mainText(page);

        // 选主动作按钮：命中候选标签且可见
        let usedLabel = '';
        for (const label of ACTION_CANDIDATES[e.id] ?? [e.action]) {
          const btn = page.getByRole('button', { name: label, exact: true }).first();
          if (await btn.isVisible().catch(() => false)) {
            usedLabel = label;
            await btn.click({ timeout: 20_000 });
            break;
          }
        }
        rec.usedLabel = usedLabel || '(未找到，可能已自动开扫)';

        const { settled, elapsed, runningAtEnd } = await waitSettled(page);
        const after = await mainText(page);
        rec.settled = settled;
        rec.elapsedMs = elapsed;
        rec.runningAtEnd = runningAtEnd;
        rec.textChanged = after !== before;
        rec.after = after.slice(0, 3000);
      } catch (err) {
        rec.error = (err as Error).message.slice(0, 300);
        rec.after = (await mainText(page).catch(() => '')).slice(0, 600);
      }
      rec.newErrors = errors;
      await page
        .screenshot({ path: path.join(SHOT_DIR, `action-${e.id}.png`) })
        .catch(() => undefined);
      writeFileSync(`/tmp/zh-nav-action-${e.id}.json`, JSON.stringify(rec, null, 2), 'utf-8');
      await app.close();
      // eslint-disable-next-line no-console
      console.log(
        `ACTROW ${JSON.stringify({ id: e.id, action: rec.usedLabel, settled: rec.settled, ms: rec.elapsedMs, err: rec.error ? 1 : 0 })}`,
      );
      expect(rec.error, `${e.label} 动作链异常`).toBeUndefined();
    });
  }
});
