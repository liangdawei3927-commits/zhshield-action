/**
 * 五语种资源键一致性守卫（防漂移）。
 *
 * 背景：2026-09-04 评估发现 ja/ko/zh-Hant 各缺 59 个键（secrets 生命周期等特性
 * 文案只进了 zh-Hans/en），运行时静默回退到默认语言，用户无感知地看到错语言。
 * 本测试让任何语种漏译在 CI 阶段直接红灯，而不是等用户截图反馈。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const LOCALES = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko'] as const;
const LOCALES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'locales');

type Json = Record<string, unknown>;

function flatten(obj: Json, prefix = ''): Set<string> {
  const keys = new Set<string>();
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') {
      for (const sub of flatten(v as Json, path)) keys.add(sub);
    } else {
      keys.add(path);
    }
  }
  return keys;
}

function loadLocale(loc: string): Json {
  return JSON.parse(readFileSync(resolve(LOCALES_DIR, `${loc}.json`), 'utf-8')) as Json;
}

describe('locale 资源键一致性', () => {
  const keysets = Object.fromEntries(LOCALES.map((loc) => [loc, flatten(loadLocale(loc))]));
  const base = keysets['zh-Hans'];

  it('基准语种 zh-Hans 非空且结构合理', () => {
    expect(base.size).toBeGreaterThan(1000);
  });

  it.each(LOCALES.slice(1))('%s 与 zh-Hans 键集合完全一致', (loc) => {
    const missing = [...base].filter((k) => !keysets[loc].has(k));
    const extra = [...keysets[loc]].filter((k) => !base.has(k));
    expect(missing, `${loc} 缺失的键（相对 zh-Hans）`).toEqual([]);
    expect(extra, `${loc} 多出的键（zh-Hans 中不存在）`).toEqual([]);
  });

  it('占位符跨语种一致（防止 {{var}} 漏译导致运行时插值失败）', () => {
    // 注意：正则必须每次用全新字面量——共享 /g 正则的 lastIndex 会在
    // test()/matchAll() 调用间串状态，导致偶发漏检（已实际踩坑）
    const extract = (s: string): Set<string> =>
      new Set([...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
    const locales = Object.fromEntries(LOCALES.map((loc) => [loc, loadLocale(loc)]));
    // 逐键比对占位符（在同一 it 内完成，避免为数千键生成数千个用例）
    for (const key of base) {
      const baseVars = extract(String(lookup(locales['zh-Hans'], key)));
      if (baseVars.size === 0) continue;
      for (const loc of LOCALES.slice(1)) {
        const raw = lookup(locales[loc], key);
        expect(extract(String(raw)), `${loc}.${key} 占位符不一致`).toEqual(baseVars);
      }
    }
  });
});

/** 按点分路径取值 */
function lookup(obj: Json, dotted: string): unknown {
  let node: unknown = obj;
  for (const part of dotted.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Json)[part];
  }
  return node;
}
