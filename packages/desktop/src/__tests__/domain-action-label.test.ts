/**
 * 域主操作按钮（健康环下面那个大按钮）的文案契约。
 *
 * 用户反馈（2026-10-25）：空态的大按钮与分类详情页的顶部按钮本该是同一个按钮，
 * 实际是两条路径 —— 空态传静态词「巡检中...」，详情页把 useTaskRun 的 progressLabel
 * 直接接进 loadingLabel，于是按钮上出现「体检中... 42% · 正在检查 src/a.ts」。
 *
 * 本测试锁三件事：
 * 1. 归一化函数真能把「百分比 + 任务消息」削成纯状态词（真阳性，不是空跑）；
 * 2. 每个域的按钮文案键在五种语言里都有真值（键写错会静默显示键名本身）；
 * 3. 页面里不许再把 progressLabel（含百分比/消息的串）接回按钮（防回归）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTION_RUNNING_LABEL_KEY,
  toPureStatusLabel,
} from '../components/business/domain-action-text';

const SRC = path.resolve(__dirname, '..');
const LOCALES = path.resolve(SRC, '../../i18n/locales');
const LANGS = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko'];

describe('按钮运行态只显示状态词', () => {
  it('把「百分比 + 任务消息」削成纯状态词（真阳性）', () => {
    expect(toPureStatusLabel('体检中... 42% · 正在检查 src/a.ts')).toBe('体检中...');
    expect(toPureStatusLabel('扫描中... 7%')).toBe('扫描中...');
    expect(toPureStatusLabel('门禁扫描中... 100% · 收尾')).toBe('门禁扫描中...');
    // 本来就是纯状态词的不许被改坏
    expect(toPureStatusLabel('盘点中...')).toBe('盘点中...');
    expect(toPureStatusLabel('')).toBe('');
    expect(toPureStatusLabel(undefined)).toBe('');
  });

  it('每个域的按钮文案键在五种语言里都有真值且不含进度信息', () => {
    const entries = Object.entries(ACTION_RUNNING_LABEL_KEY);
    // 真阳性计数：表被清空/改名时这条会先红，避免「没有违规」的假绿
    expect(entries.length).toBeGreaterThanOrEqual(10);

    for (const lang of LANGS) {
      const dict = JSON.parse(fs.readFileSync(path.join(LOCALES, `${lang}.json`), 'utf-8'));
      for (const [domain, key] of entries) {
        const value = key
          .split('.')
          .reduce<unknown>((node, k) => (node as Record<string, unknown> | undefined)?.[k], dict);
        expect(typeof value, `${lang} 缺 ${key}（域 ${domain}）`).toBe('string');
        const text = value as string;
        expect(text.length, `${lang} 的 ${key} 是空串`).toBeGreaterThan(0);
        // 状态词里不许混百分比/任务消息分隔符
        expect(text, `${lang} 的 ${key} 混入了进度信息`).not.toMatch(/%|·/);
      }
    }
  });

  it('页面不得把含进度信息的 progressLabel 接回按钮', () => {
    const dirs = ['pages', 'components/business'];
    const files: string[] = [];
    for (const dir of dirs) {
      for (const name of fs.readdirSync(path.join(SRC, dir))) {
        if (name.endsWith('.tsx') || name.endsWith('.ts')) files.push(path.join(SRC, dir, name));
      }
    }
    expect(files.length).toBeGreaterThan(50); // 扫描范围自证

    const offenders: string[] = [];
    let loadingLabels = 0;
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf-8');
      const rel = path.relative(SRC, file);
      // 1) 不许再消费 useTaskRun 的 progressLabel（它是「体检中... 42% · msg」）
      if (/\bprogressLabel\b/.test(src) && !rel.endsWith('domain-action-text.ts')) {
        offenders.push(`${rel}: 仍在消费 progressLabel`);
      }
      // 2) 残留的 loadingLabel 不许拼接/兜底运算（`progressLabel || t(...)` 就是旧病）
      for (const m of src.matchAll(/loadingLabel=\{([^}]*)\}/g)) {
        loadingLabels += 1;
        const expr = m[1].trim();
        if (/\|\||\+|`|%/.test(expr)) {
          offenders.push(`${rel}: loadingLabel={${expr}}`);
        }
      }
    }
    // 真阳性计数：剩下这些是「清理秒数/清理中」这类纯状态词，允许存在
    expect(loadingLabels).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
