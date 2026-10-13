/**
 * 复现智汇码盾 refactor duplicated-code 检测 —— 用项目自身的 ast-helper 逻辑
 * 对当前工作树扫描，输出重复对（file:line 双侧），与平台上报告的 100 条对比。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFile } from '/Users/dawei/Desktop/ZHCodeShield/zhihui-codeshield/packages/refactor/src/ast-helper.ts';
import { findDuplicateCodeBlocks } from '/Users/dawei/Desktop/ZHCodeShield/zhihui-codeshield/packages/refactor/src/ast-helper.ts';

const ROOT = '/Users/dawei/Desktop/ZHCodeShield/zhihui-codeshield';

function walk(dir: string, out: string[]): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'build') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (
      ent.name.endsWith('.ts') &&
      !ent.name.endsWith('.d.ts') &&
      !p.includes('/__tests__/') &&
      !p.includes('/e2e/') &&
      !p.includes('/fixtures/')
    ) {
      out.push(p);
    }
  }
}

// 模拟平台的扫描范围：packages/*/src/** + desktop/electron/**
const files: string[] = [];
for (const pkg of fs.readdirSync(path.join(ROOT, 'packages'))) {
  const pkgDir = path.join(ROOT, 'packages', pkg);
  if (!fs.statSync(pkgDir).isDirectory()) continue;
  if (pkg.startsWith('.')) continue;
  walk(path.join(pkgDir, 'src'), files);
  if (pkg === 'desktop') walk(path.join(pkgDir, 'electron'), files);
}
files.sort();

const all = files.map((f) => parseFile(f));
const dups = findDuplicateCodeBlocks(all, 6);

console.log(`files=${all.length} duplicates(pairs)=${dups.length}`);
for (const d of dups) {
  console.log(`${path.relative(ROOT, d.files[0])}:${d.lines[0]} <-> ${path.relative(ROOT, d.files[1])}:${d.lines[1]} (${d.lineCount}L)`);
}