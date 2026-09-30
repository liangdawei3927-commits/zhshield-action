import { test, expect } from '@playwright/test';
import { ENTRIES, launchApp, entryButton } from './nav-helpers';

/**
 * 主页(空态)大健康环验证 —— 临时验证: 分类页无检查结果进入空态主页时,
 * 中央应渲染 DomainScoreRing(270° HealthRing svg + '--' 或分数)。
 * 抽样 3 域确认(quality/security/garbage),不代表全量。
 */
const SAMPLES = ['inspect', 'security', 'garbage'];

test.describe('主页空态大环(临时验证)', () => {
  test.setTimeout(120_000);

  for (const id of SAMPLES) {
    const e = ENTRIES.find((x) => x.id === id)!;
    test(`[${id}] 空态主页渲染健康环`, async () => {
      const { app, page, errors } = await launchApp();
      try {
        await entryButton(page, e).click({ timeout: 30_000 });
        await page.waitForTimeout(2500);
        expect(errors).toEqual([]);
        // 中央刻度文本(健/康/分 或 0/50/100)必须可见 → 说明 HealthRing 已渲染
        const gauge = page
          .locator('svg text')
          .filter({ hasText: /健|康|分|0|50|100/ })
          .first();
        await expect(gauge).toBeVisible({ timeout: 15_000 });
        // 环数: 空态页应至少一个 svg 圆
        const svgs = await page.locator('svg').count();
        expect(svgs, '空态主页应有 HealthRing svg').toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    });
  }
});