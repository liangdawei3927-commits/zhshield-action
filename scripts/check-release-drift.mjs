#!/usr/bin/env node
/**
 * 发布漂移门禁 —— 防止「代码改了一堆，版本号纹丝不动」。
 *
 * 为什么需要这道门（2026-10-29 实锤的根因）：
 *   0.2.0 之后累计 103 个提交（feat/fix 70 个）从未触发版本递进，版本号一直停在 0.2.0。
 *   客户端 electron-updater 的更新判定是「latest-mac.yml 的 version > 本地 app.getVersion()」，
 *   版本不变 ⇒ 客户端恒判定「已是最新」⇒ 那批修复一个都送不到用户机器上。
 *   版本号本身不该自动递增（semver 语义只能人定），但「忘了声明」必须立刻变红，
 *   而不是像这次一样静默漂移三个月。
 *
 * 判定逻辑（不依赖 PR/base branch，对本仓库「单人线性往 main 推」的场景同样成立）：
 *   取最近一个合法 X.Y.Z 语义 tag 作为「上一次发版」锚点：
 *   - package version > tag  ⇒ 已递进，等打 tag ⇒ 通过（仅提示）
 *   - package version == tag ⇒ 检查 tag..HEAD 有无影响发布产物的源码改动
 *       · 无改动 ⇒ 通过
 *       · 有改动 ⇒ **失败**（代码变了但版本没升，正是本次故障形态）
 *   - package version < tag  ⇒ 版本倒退 ⇒ 失败
 *   - 不存在任何合法 tag     ⇒ 首次发布，提示后放行（不做无谓阻断）
 *
 * 为什么不用 `changeset status --since=origin/main`：
 *   本仓库几乎全是直接推 main，CI 检出后 origin/main 就是 HEAD 自身，
 *   `--since` 永远为空 ⇒ 门禁结构上永不红。这正是必须换成「锚定 tag」的原因。
 *
 * 用法：
 *   node scripts/check-release-drift.mjs            # 默认硬失败（已作为 build:mac 前置）
 *   node scripts/check-release-drift.mjs --allow    # 逃逸舱：本地临时试包，明确承认本次不递进
 *   node scripts/check-release-drift.mjs --strict   # CI/发布通道：等同默认，语义显式化
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP_PKG = path.join(ROOT, 'packages/desktop/package.json');

const STRICT = process.argv.includes('--strict');
const ALLOW = process.argv.includes('--allow');

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * 纳入漂移统计的路径：能进入发布产物的源码目录。
 *
 * 这里用 JS 正则过滤，**不用 git pathspec**（2026-10-29 修的真缺陷）：
 * 原实现把路径交给了 `git diff --name-only tag..HEAD -- <pathspec...>`，
 * 其中「通配符 + 目录名」形式的 pathspec 恒不匹配 —— git 的通配 pathspec
 * 不做隐式递归补全，必须显式写到 `/**`。10-29 实测（同一 commit 区间）：
 *   git diff -- 带 `packages/(星)/src`        → 0 条
 *   git diff -- 带 `packages/(星)/src/(星)(星)` → 2 条
 * 于是门禁对**所有源码改动视而不见**，只剩 packages 下各包的直接文件
 * （如 package.json）能命中 ⇒ 一道看着在跑、实际 95% 恒绿的假门。
 * 发现契机：改完 electron/main.ts 后门禁仍报「自 v0.3.0 以来无发布产物改动」。
 * 改为「先取全量 diff，再在 JS 里过滤」，路径语义不再依赖 git 的 glob 规则。
 */
const INCLUDE_RE = [
  /^packages\/[^/]+\/(src|electron|bin|assets|presets)\//,
  /^packages\/[^/]+\/package\.json$/,
  /^packages\/desktop\/vite\.config\.ts$/,
];

/**
 * 反空转自检样本：每个样本都必须能被 INCLUDE_RE 命中至少一次。
 * 防止将来改正则时写成「永不匹配」，把门禁悄悄变回假绿。
 */
const INCLUDE_SAMPLES = [
  'packages/desktop/electron/main.ts',
  'packages/kernel/src/runner.ts',
  'packages/cli/bin/zhshield.mjs',
  'packages/kernel/assets/eslint/eslint.config.mjs',
  'packages/desktop/package.json',
  'packages/desktop/vite.config.ts',
];

/** 明确不算「发布产物改动」的：测试、文档、快照、覆盖率 */
const EXCLUDE_RE = [
  /(^|\/)__tests__\//,
  /(^|\/)test-results\//,
  /\.test\.tsx?$/,
  /\.spec\.tsx?$/,
  /\.snap$/,
  /\.md$/,
];

function readVersion() {
  return JSON.parse(readFileSync(DESKTOP_PKG, 'utf-8')).version ?? '';
}

/**
 * 最近一个「合法语义版本」tag。
 * 必须白名单过滤：`v1` 是 zhshield-action 官方 Action 的 bundle 引用，
 * 它不是产品版本，把它当锚点会让整个判定错位。
 */
function latestReleaseTag() {
  try {
    const tags = execFileSync('git', ['tag', '-l', '--sort=-v:refname', '--merged', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    return tags.find((t) => /^v/.test(t) && SEMVER_RE.test(t.slice(1))) ?? '';
  } catch {
    return '';
  }
}

/** semver 数值段比较（预发布后缀不影响主版本号判定） */
function cmpVersion(a, b) {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/** tag..HEAD 之间影响发布产物的改动文件（全量 diff + JS 过滤） */
function driftFilesSince(tag) {
  const out = execFileSync('git', ['diff', '--name-only', `${tag}..HEAD`], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => INCLUDE_RE.some((re) => re.test(f)))
    .filter((f) => !EXCLUDE_RE.some((re) => re.test(f)));
}

// 反空转自检（fail-closed）：样本必须被命中，否则门禁会退化成「永远说无改动」
const unmatchedSamples = INCLUDE_SAMPLES.filter((s) => !INCLUDE_RE.some((re) => re.test(s)));
if (unmatchedSamples.length > 0) {
  console.error(
    `[release-drift] ✗ 内部自检失败：以下样本路径未被任何 INCLUDE_RE 命中 —— ${unmatchedSamples.join(', ')}\n` +
      '  说明路径过滤器写坏了，门禁会静默放行所有源码改动。请先修正 INCLUDE_RE。',
  );
  process.exit(1);
}

const pkgVersion = readVersion();
const tag = latestReleaseTag();

if (!SEMVER_RE.test(pkgVersion)) {
  console.error(`[release-drift] ✗ packages/desktop/package.json 的 version "${pkgVersion}" 不是合法 semver`);
  process.exit(1);
}

const fixHint = [
  '  修复任选其一：',
  '  · 语义递进：pnpm --filter @zh/desktop exec npm version minor --no-git-tag-version',
  '    （patch / minor / major 按改动性质自行判断，工具无法代劳）',
  '  · 或写 changeset 后跑 pnpm changeset:version',
  '  · 本地临时试包确实不想递进：node scripts/check-release-drift.mjs --allow',
].join('\n');

if (!tag) {
  console.warn('[release-drift] 未找到任何合法语义 tag（如 v0.3.0），视为首次发布，跳过漂移检查。');
  console.log(`[release-drift] 当前版本 = ${pkgVersion}`);
  process.exit(0);
}

const tagVersion = tag.replace(/^v/, '');
const cmp = cmpVersion(pkgVersion, tagVersion);

if (cmp < 0) {
  console.error(
    `[release-drift] ✗ 版本倒退：tag ${tag} 对应 ${tagVersion}，而 packages/desktop 当前为 ${pkgVersion}。\n${fixHint}`,
  );
  process.exit(1);
}

if (cmp > 0) {
  console.log(
    `[release-drift] ✓ 版本已递进 ${tagVersion} → ${pkgVersion}。记得发版时补 tag：git tag v${pkgVersion}（务必 v 前缀）。`,
  );
  process.exit(0);
}

// cmp === 0：版本号与已发布版本相同，检查是否有未计入的改动
let files = [];
try {
  files = driftFilesSince(tag);
} catch (err) {
  // git 不可用 / 浅克隆取不到 diff：宁可被看见，也不要按「无改动」静默放行
  console.error(
    `[release-drift] ✗ 无法计算 ${tag}..HEAD 的改动（${err.message}）。浅克隆请加 fetch-depth: 0。\n${fixHint}`,
  );
  process.exit(1);
}

if (files.length === 0) {
  console.log(`[release-drift] ✓ 自 ${tag} 以来无发布产物改动，版本 ${pkgVersion} 无需递进。`);
  process.exit(0);
}

const shown = files.slice(0, 15);
const rest = files.length - shown.length;
console.error(
  [
    `[release-drift] ✗ 自 ${tag} 以来有 ${files.length} 个文件改动，但 packages/desktop 版本仍是 ${pkgVersion}。`,
    '  版本号不变 ⇒ 客户端 electron-updater 比对 latest-mac.yml 后判定「已是最新」，这批改动一个都送不到用户端。',
    '  涉及文件：',
    ...shown.map((f) => `    - ${f}`),
    ...(rest > 0 ? [`    … 另有 ${rest} 个`] : []),
    fixHint,
  ].join('\n'),
);

if (ALLOW) {
  console.warn('[release-drift] ⚠ 已指定 --allow，本次放行。**严禁**用于对外发布的安装包。');
  process.exit(0);
}

if (!STRICT) {
  console.error('[release-drift] 本地打包确需跳过，加 --allow；这是留给开发者的临时逃逸舱，CI 通道请勿使用。');
}

process.exit(1);
