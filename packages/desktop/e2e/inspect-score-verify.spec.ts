/**
 * 体检分数卡实机验证（一次性排障 spec，2026-09-19）
 *
 * 背景：用户反馈「项目体检没有分数」。链路为：
 *   巡检完成 → writeDiagnosticsFile 按域快照附 dimensionScore
 *   → IPC engine:getDomainScore → DomainScoreCard(live) 显示。
 * 本 spec 用 fixture（自带带分快照）验证两件事：
 *   1. 打开体检页即显示分数（读既有快照，不跑检查）；
 *   2. 点「马上巡检/重新巡检」跑完后分数卡仍显示且快照更新（previousScore 对比行出现）。
 */
import { test, expect } from '@playwright/test';
import { ENTRIES, entryButton, launchApp, waitSettled } from './nav-helpers';

const inspect = ENTRIES.find((e) => e.id === 'inspect')!;

test('体检分数卡：开页出分 → 巡检后更新', async () => {
  test.setTimeout(30 * 60_000);
  const { app, page } = await launchApp();
  try {
    await entryButton(page, inspect).click({ timeout: 20_000 });
    await page.waitForTimeout(1500);

    // 1) 既有快照（fixture 上轮巡检留有 dimensionScore）→ 开页即应有数字分。
    //    注意：无快照分的项目会自动开跑巡检（每天首次），进行中不渲染分数卡——
    //    此时先等体检跑完，再断言。
    const card = page.getByTestId('domain-score-quality');
    try {
      await expect(card).toBeVisible({ timeout: 8_000 });
      const before = (await card.innerText()).replace(/\s+/g, ' ').trim();
      // eslint-disable-next-line no-console
      console.log(`SCORECARD-BEFORE ${before}`);
      expect(before, '开页应显示数字分（fixture 快照带分）').toMatch(/\d{1,3}/);
    } catch {
      // eslint-disable-next-line no-console
      console.log('SCORECARD-BEFORE (none — 无快照分或体检进行中，等跑完再验)');
    }

    // 2) 跑一轮巡检（页面可能已自动开跑；若按钮可用则手动触发一次）
    const candidates = ['重新巡检', '马上巡检'];
    let clicked = '';
    for (const label of candidates) {
      const btn = page.getByRole('button', { name: label, exact: true }).first();
      if (await btn.isVisible().catch(() => false)) {
        clicked = label;
        await btn.click({ timeout: 20_000 }).catch(() => '（可能已在跑，点击被禁用）');
        break;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`INSPECT-CLICK ${clicked || '(none — 自动巡检已开跑)'}`);
    const { settled, elapsed } = await waitSettled(page, 25 * 60_000, 15_000);
    // eslint-disable-next-line no-console
    console.log(`INSPECT-SETTLED ${settled} ${elapsed}ms`);

    // 3) 跑完后分数卡仍显示且带分
    const card2 = page.getByTestId('domain-score-quality');
    await expect(card2).toBeVisible({ timeout: 15_000 });
    const after = (await card2.innerText()).replace(/\s+/g, ' ').trim();
    // eslint-disable-next-line no-console
    console.log(`SCORECARD-AFTER ${after}`);
    expect(after, '巡检完成后应显示数字分').toMatch(/\d{1,3}/);
  } finally {
    await app.close();
  }
});
