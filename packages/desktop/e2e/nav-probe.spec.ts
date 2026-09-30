/**
 * 顶部导航 11 功能 · 阶段C：穿透式取证
 *
 *  C1 一键体检域级回执：直接取 runFullCheck 的返回对象（reran/skipped/failed），
 *     定位「仪表盘 100 分 / 0 项」与「质量巡检页检出 4 条」的口径冲突。
 *  C2 安全中心 → 密钥管理：验证夹具里植入的 4 类硬编码密钥能否被检出。
 *
 * 运行：ZH_NAV_FIXTURE=/tmp/zh-nav-fixture pnpm exec playwright test e2e/nav-probe.spec.ts
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SHOT_DIR, launchApp, mainText } from './nav-helpers';

const BUSY = ['扫描中', '检测中', '盘点中', '巡检中', '正在', '检查中', '加载', '排队中'];

async function waitQuiet(page: import('@playwright/test').Page, maxMs = 300_000) {
  const t0 = Date.now();
  let last = '';
  let lastChange = Date.now();
  while (Date.now() - t0 < maxMs) {
    const txt = await mainText(page).catch(() => '');
    if (txt !== last) {
      last = txt;
      lastChange = Date.now();
    }
    const running = await page
      .evaluate(async () => {
        const api = (
          window as unknown as { electronAPI?: { tasks?: { list?: () => Promise<unknown[]> } } }
        ).electronAPI;
        if (!api?.tasks?.list) return 0;
        const l = (await api.tasks.list()) as Array<{ status?: string }>;
        return l.filter((t) => t.status === 'running' || t.status === 'queued').length;
      })
      .catch(() => 0);
    if (!BUSY.some((b) => txt.includes(b)) && running === 0 && Date.now() - lastChange >= 6000) {
      return { settled: true, elapsed: Date.now() - t0 };
    }
    await page.waitForTimeout(2000);
  }
  return { settled: false, elapsed: Date.now() - t0 };
}

test.describe('顶部导航 11 功能 · 穿透取证', () => {
  test.setTimeout(30 * 60_000);

  test('[C1] 一键体检 runFullCheck 域级回执', async () => {
    const { app, page } = await launchApp();
    try {
      page.setDefaultTimeout(0);
      const fixture = process.env.ZH_NAV_FIXTURE ?? '/tmp/zh-nav-fixture';
      let result: unknown;
      let probeError: string | undefined;
      try {
        result = await page.evaluate(async (p) => {
          const api = (
            window as unknown as {
              electronAPI?: {
                engine?: { runFullCheck?: (p: string, o?: unknown) => Promise<unknown> };
              };
            }
          ).electronAPI;
          return api?.engine?.runFullCheck?.(p, { force: true });
        }, fixture);
      } catch (err) {
        probeError = (err as Error).message.slice(0, 500);
      }
      writeFileSync(
        '/tmp/zh-nav-fullcheck.json',
        JSON.stringify({ result, probeError }, null, 2),
        'utf-8',
      );
      console.log('PROBE-C1 ' + JSON.stringify({ result, probeError }));
      expect(probeError, 'runFullCheck 直接调用异常').toBeUndefined();
      expect(result).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  test('[C2] 安全中心 → 密钥管理 扫描硬编码密钥', async () => {
    mkdirSync(SHOT_DIR, { recursive: true });
    const { app, page, errors } = await launchApp();
    try {
      await page.getByRole('navigation').getByRole('button', { name: '安全中心' }).click();
      await page.waitForTimeout(1500);
      // 切到「密钥管理」页签（可能是 role=tab 或普通 button）
      const candidates = [
        page.getByRole('tab', { name: '密钥管理' }).first(),
        page.getByRole('button', { name: '密钥管理' }).first(),
        page.getByText('密钥管理', { exact: true }).first(),
      ];
      let tabUsed = '';
      for (const c of candidates) {
        if (await c.isVisible().catch(() => false)) {
          await c.click();
          tabUsed = 'found';
          await page.waitForTimeout(1500);
          break;
        }
      }
      const rec: Record<string, unknown> = { tabFound: tabUsed === 'found' };
      for (const label of ['开始扫描', '重新扫描']) {
        const btn = page.getByRole('button', { name: label, exact: true }).first();
        if (await btn.isVisible().catch(() => false)) {
          rec.usedLabel = label;
          await btn.click();
          break;
        }
      }
      const q = await waitQuiet(page);
      rec.settled = q.settled;
      rec.elapsedMs = q.elapsed;
      rec.after = (await mainText(page)).slice(0, 2500);
      rec.errors = errors;
      await page.screenshot({ path: path.join(SHOT_DIR, 'action-security-secrets.png') });
      writeFileSync('/tmp/zh-nav-secrets.json', JSON.stringify(rec, null, 2), 'utf-8');
      console.log('PROBE-C2 ' + JSON.stringify({ usedLabel: rec.usedLabel, settled: rec.settled }));
      expect(rec.error).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
