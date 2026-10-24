/**
 * 空态/主页文案的诚实性护栏 —— 空态副标题不得编造数据。
 *
 * 背景（2026-10-25）：`BackupEmptyState` 的副标题是 i18n 的「上次备份：{{date}}」，
 * 而 `date` 传的是 `new Date()` —— 从未备份过的项目也会显示「上次备份：刚刚」，
 * 且时间看起来完全合理，用户无法识别是假的。更糟的是这个「空态」组件同时充当
 * 分类主页（`showHome=true` 时渲染），有历史记录时也会出现，于是谎报频率更高。
 *
 * 为什么行为测试抓不到：断言「副标题渲染出来了」永远是绿的 —— 假数据也是数据。
 * 只能按源码口径锁住「副标题表达式里不许出现当前时间」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..');

/** 扫描目录下所有 tsx 的 subtitle 表达式 */
function collectSubtitleExpressions(dir: string): { file: string; expr: string }[] {
  const out: { file: string; expr: string }[] = [];
  for (const name of fs.readdirSync(path.join(SRC, dir))) {
    if (!name.endsWith('.tsx')) continue;
    const src = fs.readFileSync(path.join(SRC, dir, name), 'utf-8');
    // subtitle={...} 的表达式内部不含花括号（本项目全部是 t(...) 调用或三元）
    for (const m of src.matchAll(/subtitle=\{([^}]*)\}/g)) {
      out.push({ file: `${dir}/${name}`, expr: m[1] });
    }
  }
  return out;
}

describe('空态/主页副标题不得编造数据', () => {
  it('subtitle 表达式里不出现当前时间（new Date / Date.now）', () => {
    const found = [
      ...collectSubtitleExpressions('pages'),
      ...collectSubtitleExpressions('components/business'),
    ];
    // 真阳性计数：少于 8 处说明正则失效（改名/换行导致），而不是「没有违规」
    expect(found.length).toBeGreaterThanOrEqual(8);

    const offenders = found
      .filter(({ expr }) => /new Date|Date\.now/.test(expr))
      .map(({ file, expr }) => `${file}: subtitle={${expr.trim()}}`);
    expect(offenders).toEqual([]);
  });

  it('备份主页副标题取自真实文案键，且旧的「上次备份」假时间键已删除', () => {
    const src = fs.readFileSync(path.join(SRC, 'pages/backup-empty-state.tsx'), 'utf-8');
    expect(src).toContain("t('page.backup.empty.subtitle')");
    expect(src).not.toContain('empty.lastBackup');

    // 五语言键一致性由 @zh/i18n 的 locale-parity 测试负责，这里只确认键真的存在
    const locales = path.resolve(SRC, '../../i18n/locales');
    for (const lang of ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko']) {
      const dict = JSON.parse(fs.readFileSync(path.join(locales, `${lang}.json`), 'utf-8'));
      const empty = dict.page.backup.empty;
      expect(empty.subtitle, `${lang} 缺 subtitle`).toBeTruthy();
      expect(empty.lastBackup, `${lang} 残留 lastBackup`).toBeUndefined();
    }
  });
});
