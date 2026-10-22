/**
 * 顶部导航 11 功能 · 阶段A：入口可达 + 页面渲染 + 运行时错误采集
 *
 * 遍历「全部 11 个导航入口」（TopNav 10 项 + 侧边栏项目行报告中心），
 * 对每页断言其标识文案可见，并采集 console error / pageerror。
 * ⛔ 规则进化 / AI 工具已暂下线（见 src/feature-flags.ts），不再遍历。
 *
 * 运行：ZH_NAV_FIXTURE=/tmp/zh-nav-fixture pnpm exec playwright test e2e/nav-render.spec.ts
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ENTRIES, SHOT_DIR, clickEntry, launchApp, mainText } from './nav-helpers';

test.describe('顶部导航 11 功能 · 渲染与运行时健康', () => {
  test.setTimeout(180_000);

  test('11 个入口全部可点击且页面正常渲染（无渲染异常）', async () => {
    mkdirSync(SHOT_DIR, { recursive: true });
    const { app, page, errors } = await launchApp();
    const rows: Array<Record<string, unknown>> = [];
    try {
      for (const e of ENTRIES) {
        const before = errors.length;
        let clicked = false;
        let marker = '';
        let excerpt = '';
        try {
          await clickEntry(page, e);
          clicked = true;
          const txt = await mainText(page);
          for (const m of e.markers) {
            if (txt.includes(m)) {
              marker = m;
              break;
            }
          }
          excerpt = txt.slice(0, 300);
        } catch (err) {
          excerpt = `FAIL: ${(err as Error).message.slice(0, 200)}`;
        }
        await page.screenshot({ path: path.join(SHOT_DIR, `${e.id}.png`) }).catch(() => undefined);
        const newErrors = errors.slice(before);
        rows.push({ id: e.id, label: e.label, where: e.where, clicked, marker, newErrors, excerpt });
        console.log(
          `NAVROW ${JSON.stringify({ id: e.id, label: e.label, clicked, marker: marker || '(none)', errCount: newErrors.length })}`,
        );
      }
    } finally {
      writeFileSync('/tmp/zh-nav-render.json', JSON.stringify(rows, null, 2), 'utf-8');
      await app.close();
    }

    const failed = rows.filter((r) => !r.clicked || !r.marker);
    console.log(
      `NAVSUMMARY render failed=${failed.length}/${rows.length} :: ${failed.map((f) => f.id).join(',') || '(none)'}`,
    );
    expect(failed.map((f) => f.id), '渲染失败的导航项').toEqual([]);
  });
});
