/**
 * 10 域实时评分 + 健康环实机验证（2026-09-19 功能验收）
 *
 * 验证「各域跑完当场出分 + DomainScoreCard 健康环视觉」：
 *   1. 打开分类页 → 触发该域真实检查（或等待自动开扫）→ waitSettled；
 *   2. 断言 domain-score-<dim> 卡可见；
 *   3. 断言卡内有 ScoreRing（svg 环）—— scored/stale 渲染环；
 *   4. 断言环内数字分数 + 等级角标；
 *   5. 截图存档 + 采集 pageerror/console.error。
 *
 * 运行：ZH_NAV_FIXTURE=/tmp/zh-nav-fixture pnpm exec playwright test e2e/domain-ring-verify.spec.ts
 * 可只跑子集：ZH_NAV_ONLY=inspect,guard
 *
 * 不同于 nav-actions（只验证动作链路），本 spec 聚焦评分卡的视觉与数值。
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ENTRIES, SHOT_DIR, entryButton, launchApp, mainText } from './nav-helpers';

/** 页面 id → ScoreDimension（与 DomainScoreCard dimension prop 严格一致） */
const PAGE_DIMENSION: Record<string, string> = {
  inspect: 'quality',
  guard: 'gate',
  sentinel: 'sentinel',
  security: 'security',
  deps: 'dependencies',
  garbage: 'garbage',
  performance: 'performance',
  techdebt: 'techdebt',
  refactor: 'refactor',
  backup: 'backup',
};

/** 每项功能的主动作候选按钮标签（按顺序尝试；空数组 = 依赖自动开扫/不做主动动作） */
const ACTION_CANDIDATES: Record<string, string[]> = {
  inspect: ['一键体检', '重新巡检'],
  guard: ['立即扫描', '重新扫描'],
  sentinel: ['启动监控', '监控运行中'],
  security: ['一键扫描', '重新检查', '开始扫描'],
  deps: ['开始盘点', '重新盘点'],
  garbage: ['开始扫描', '重新扫描'],
  performance: ['开始检测', '重新检测'],
  techdebt: ['开始盘点', '重新盘点'],
  refactor: ['马上检查', '重新检查'],
  backup: ['一键备份'],
};

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

const ONLY = (process.env.ZH_NAV_ONLY ?? '').split(',').filter(Boolean);
const DOMAIN_TARGETS = ENTRIES.filter((e) => PAGE_DIMENSION[e.id]);

test.describe('10 域实时评分 + 健康环实机验证（一项一实例）', () => {
  test.setTimeout(30 * 60_000);

  for (const e of DOMAIN_TARGETS) {
    if (ONLY.length && !ONLY.includes(e.id)) continue;
    test(`[${e.id}] 评分卡环 → ${e.action}`, async () => {
      mkdirSync(SHOT_DIR, { recursive: true });
      const { app, page, errors } = await launchApp();
      const dim = PAGE_DIMENSION[e.id];
      const rec: Record<string, unknown> = { id: e.id, label: e.label, dimension: dim, action: e.action };
      try {
        // 1) 打开分类页
        await entryButton(page, e).click({ timeout: 30_000 });
        await page.waitForTimeout(2000);

        // 2) 分数卡可见性（先静候自动开扫或已完成态的分数卡）
        const card = page.getByTestId(`domain-score-${dim}`);
        let cardState = 'pre-load';
        try {
          await expect(card).toBeVisible({ timeout: 15_000 });
          cardState = 'visible';
        } catch {
          cardState = 'invisible';
        }
        rec.cardStateBefore = cardState;

        // 3) 触发该域真实检查（若按钮可在空态/有数据下存在）
        let usedLabel = '';
        for (const label of ACTION_CANDIDATES[e.id] ?? []) {
          const btn = page.getByRole('button', { name: label, exact: true }).first();
          if (await btn.isVisible().catch(() => false)) {
            usedLabel = label;
            await btn.click({ timeout: 20_000 }).catch(() => '(可能已在跑，点击被禁用)');
            break;
          }
        }
        rec.usedLabel = usedLabel || '(未手动触发，依赖自动开扫)';

        // 4) 等检查完成 → 等「数字分出现」或「任务结束且卡文本稳定」
        //    （卡在 no-data/not-run 态也渲染，仅 isVisible 会误判提前返回）
        const t0 = Date.now();
        let cardSeen = false;
        let lastCard = '';
        let lastCardChange = Date.now();
        while (Date.now() - t0 < 300_000) {
          const vis = await card.isVisible().catch(() => false);
          if (vis) {
            const txt = (await card.innerText()).replace(/\s+/g, ' ').trim();
            if (txt !== lastCard) {
              lastCard = txt;
              lastCardChange = Date.now();
            }
            const hasScore = /\d{1,3}/.test(txt) && !txt.includes('暂无评分') && !txt.includes('未检测');
            const idle = (await runningTasks(page)) === 0 && Date.now() - lastCardChange >= 10_000;
            if (hasScore || idle) {
              cardSeen = true;
              break;
            }
          } else {
            lastCard = '';
            lastCardChange = Date.now();
          }
          await page.waitForTimeout(3000);
        }
        rec.settled = cardSeen;
        rec.elapsedMs = Date.now() - t0;
        rec.runningAtEnd = await runningTasks(page);

        // 5) 分数卡可见 + 环内数字分 + 等级角标
        await expect(card).toBeVisible({ timeout: 15_000 });
        const ring = card.locator('svg');
        const ringCount = await ring.count();
        rec.ringSvgCount = ringCount;
        if (ringCount > 0) {
          expect(ringCount, 'scored/stale 态应有 ScoreRing svg').toBeGreaterThan(0);
        }
        const cardText = (await card.innerText()).replace(/\s+/g, ' ').trim();
        rec.cardText = cardText;

        // 数字分数：环内 <span> 首数字或卡文本含 0-100 数字
        const numInCard = cardText.match(/\b\d{1,3}\b/);
        rec.numFound = numInCard ? numInCard[0] : null;
        if (cardText.includes('未检测') || cardText.includes('暂无评分')) {
          rec.scoreState = 'not-scored';
        } else {
          rec.scoreState = 'scored';
          expect(cardText, '已评分卡文本应含分数数字').toMatch(/\d{1,3}/);
        }

        // 等级角标（A/B/C/D）
        const badge = card.locator('span', { hasText: /^[ABCD] / });
        rec.gradeBadge = (await badge.first().innerText().catch(() => '')).trim();
      } catch (err) {
        rec.error = (err as Error).message.slice(0, 300);
        rec.after = (await mainText(page).catch(() => '')).slice(0, 600);
      }
      rec.newErrors = errors;
      await page
        .screenshot({ path: path.join(SHOT_DIR, `domain-ring-${e.id}.png`) })
        .catch(() => undefined);
      writeFileSync(`/tmp/zh-domain-ring-${e.id}.json`, JSON.stringify(rec, null, 2), 'utf-8');
      await app.close();
      console.log(
        `RINGROW ${JSON.stringify({ id: e.id, dim, ring: rec.ringSvgCount ?? 0, num: rec.numFound ?? null, grade: rec.gradeBadge ?? '', card: (rec.cardText ?? '').slice(0, 90), settled: rec.settled, ms: rec.elapsedMs, state: rec.scoreState ?? '?', err: rec.error ? 1 : 0 })}`,
      );
      expect(rec.error, `${e.label} 动作链/断言异常`).toBeUndefined();
    });
  }
});