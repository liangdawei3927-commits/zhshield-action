#!/usr/bin/env node
/**
 * 应用版本号真源校验。
 *
 * 唯一真源：`packages/desktop/package.json` 的 `version`。
 *
 * 为什么只认这一个字段：
 * - electron-builder 用它写安装包 `Info.plist` 的 `CFBundleShortVersionString`；
 * - 运行时 `app.getVersion()` 读的也是它；
 * - 渲染进程侧边栏通过 `__APP_VERSION__`（vite define 注入）读同一字段。
 * 三者同源，改一处即可，界面/访达/更新比对不会各说各话。
 *
 * 明确**不参与**版本的：
 * - 根 `package.json` 的 version（monorepo 私有根包，与产品版本无关）；
 * - git tag（历史发布标记，命名应对齐 `v<version>`，但不作为读取源）。
 *
 * 判定级别：
 * - 版本非法 semver ⇒ 失败（退出码 1，阻断打包）；
 * - 最近 `v*` tag 与版本不一致 ⇒ 默认仅提示。tag 落后于版本号是正常开发态
 *   （先改版本再打包，打 tag 通常更晚），不该因此挡住日常打包；
 * - 加 `--strict-tag` ⇒ tag 不一致升级为失败。发布通道必须用严格模式：
 *   由 tag 触发构建时，tag 与版本不一致等于「发布版本 ≠ 安装包版本」，
 *   更新链路（latest-mac.yml 与 app.getVersion 比对）会直接错位。
 *
 * 用法：
 * - `node scripts/check-app-version.mjs`（本地打包，已作为 `build:mac` 前置）
 * - `node scripts/check-app-version.mjs --strict-tag`（CI 发布通道）
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP_PKG = path.join(ROOT, 'packages/desktop/package.json');
const ROOT_PKG = path.join(ROOT, 'package.json');

const STRICT_TAG = process.argv.includes('--strict-tag');

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** 读 JSON；文件缺失/损坏直接抛，避免用假数据通过校验 */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf-8'));
}

/** 最近的对齐用 tag（只匹配 v 开头且后接数字的），取不到返回空串 */
function latestVersionTag() {
  try {
    return execFileSync(
      'git',
      ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'],
      { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    // 无 tag / 非 git 仓库 / git 不可用：不视为错误
    return '';
  }
}

const desktopVersion = readJson(DESKTOP_PKG).version ?? '';
const rootVersion = readJson(ROOT_PKG).version ?? '';

let failed = false;

if (!SEMVER_RE.test(desktopVersion)) {
  console.error(
    `[version] ✗ packages/desktop/package.json 的 version "${desktopVersion}" 不是合法 semver（应为 X.Y.Z）`,
  );
  failed = true;
}

if (failed) {
  process.exit(1);
}

const tag = latestVersionTag();
if (tag) {
  const tagVersion = tag.replace(/^v/, '');
  if (SEMVER_RE.test(tagVersion) && tagVersion !== desktopVersion) {
    const msg =
      `最近 tag ${tag} 与当前版本 ${desktopVersion} 不一致（正式发版应让 tag 为 v${desktopVersion}）`;
    if (STRICT_TAG) {
      console.error(`[version] ✗ ${msg}。发布通道已启用 --strict-tag，构建中止。`);
      process.exit(1);
    }
    console.warn(`[version] 提示：${msg}。本地打包不受影响。`);
  }
}

console.log(`[version] 应用版本 = ${desktopVersion}（真源 packages/desktop/package.json）`);
if (rootVersion && rootVersion !== desktopVersion) {
  console.log(
    `[version] 根 package.json 的 ${rootVersion} 是私有根包版本，**不参与**打包版本，忽略即可。`,
  );
}
