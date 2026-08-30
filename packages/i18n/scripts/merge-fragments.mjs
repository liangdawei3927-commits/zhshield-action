#!/usr/bin/env node
/**
 * 将 locales/fragments/*.json 深合并到 locales/zh-Hans.json（源语言目录）。
 *
 * 用法：pnpm --filter @zh/i18n merge-fragments
 *
 * 设计：多个迁移 agent 并行工作，各自把提取出的翻译键写入独立片段文件
 * （如 fragments/desktop-pages-guard.json），本脚本在收尾阶段统一合并，
 * 避免并发编辑同一文件导致覆盖丢失。
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FRAGMENTS_DIR = join(ROOT, 'locales', 'fragments');
const TARGET = join(ROOT, 'locales', 'zh-Hans.json');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, source, path = '') {
  for (const [key, value] of Object.entries(source)) {
    const keyPath = path ? `${path}.${key}` : key;
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMerge(target[key], value, keyPath);
    } else if (isPlainObject(value) && target[key] !== undefined) {
      throw new Error(`类型冲突 @ ${keyPath}: 目标已有非对象值`);
    } else if (isPlainObject(value)) {
      target[key] = value;
    } else if (target[key] !== undefined) {
      // 叶子键重复：仅当源值相同时静默跳过，否则报错防覆盖
      if (target[key] !== value) {
        throw new Error(`键重复且值不同 @ ${keyPath}: "${target[key]}" vs "${value}"`);
      }
    } else {
      target[key] = value;
    }
  }
}

function sortKeys(obj) {
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = isPlainObject(obj[key]) ? sortKeys(obj[key]) : obj[key];
  }
  return sorted;
}

function collectLeaves(obj, prefix = '', out = []) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      collectLeaves(value, path, out);
    } else {
      out.push(path);
    }
  }
  return out;
}

if (!existsSync(FRAGMENTS_DIR)) {
  console.log('[merge-fragments] 无片段目录，跳过');
  process.exit(0);
}

const fragmentFiles = readdirSync(FRAGMENTS_DIR).filter((f) => f.endsWith('.json')).sort();
if (fragmentFiles.length === 0) {
  console.log('[merge-fragments] 无片段文件，跳过');
  process.exit(0);
}

const target = JSON.parse(readFileSync(TARGET, 'utf8'));
const before = new Set(collectLeaves(target));

const applied = [];
for (const file of fragmentFiles) {
  const fragment = JSON.parse(readFileSync(join(FRAGMENTS_DIR, file), 'utf8'));
  deepMerge(target, fragment);
  applied.push(file);
}

const after = new Set(collectLeaves(target));
const added = Array.from(after, (k) => k).toSorted().filter((k) => !before.has(k));

// 合并后再排序写回，保证确定性 diff
writeFileSync(TARGET, `${JSON.stringify(sortKeys(target), null, 2)}\n`, 'utf8');

// 合并成功后清理片段文件（保留目录）
for (const file of fragmentFiles) {
  rmSync(join(FRAGMENTS_DIR, file));
}

console.log(`[merge-fragments] 合并 ${applied.length} 个片段：${applied.join(', ')}`);
console.log(`[merge-fragments] 新增 ${added.length} 个叶子键，zh-Hans.json 现有 ${after.size} 个叶子键`);
