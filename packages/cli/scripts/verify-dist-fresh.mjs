#!/usr/bin/env node
// @ts-check
/**
 * verify-dist-fresh.mjs — 校验「提交进仓库的 CLI bundle」是否就是当前源码的产物（报告 §5.3）
 *
 * 风险：dist/zhshield.js 提交进 git（GitHub Action / npx 直装依赖它）。改了 src 忘记
 * build，则 test/typecheck（跑 src）永远绿，而用户拿到的是旧代码。
 *
 * 判据（跨平台）：build-cli.mjs 把「esbuild 实际打包的源文件内容指纹」写进 bundle 头部
 * `@zh-src-hash`。本脚本比较工作区构建产物与 git HEAD 中提交产物的指纹。
 * 不直接比文件字节：esbuild 产物可能有平台差异（ubuntu CI 比 macOS 产物会误报）。
 *
 * 用法：node scripts/verify-dist-fresh.mjs [--no-build]
 * 退出码：0 一致 / 1 不一致或无法校验 / 2 环境错误
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const bundlePath = resolve(repoRoot, 'packages/cli/dist/zhshield.js');
const relBundlePath = 'packages/cli/dist/zhshield.js';
const STAMP_RE = /^\/\/ @zh-src-hash: ([0-9a-f]{16})$/m;
const FILES_RE = /^\/\/ @zh-src-files: (\d+)$/m;

/** 只在 banner（前 8 行）找指纹，避免误命中正文同形字符串 */
const headOf = (text) => text.split('\n', 8).join('\n');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function main() {
  // 默认先构建：判据是「提交的产物 == 当前源码的产物」，没有"当前源码的产物"就无从比较。
  // CI 里 Build 步骤已用同一份源码构建过，用 --no-build 跳过以省时间。
  if (!process.argv.includes('--no-build')) {
    execFileSync('pnpm', ['--filter', 'zhshield-cli', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  }
  if (!existsSync(bundlePath)) {
    console.error(`❌ 找不到工作区产物：${relBundlePath}（先 pnpm --filter zhshield-cli build）`);
    process.exit(2);
  }
  const workingText = readFileSync(bundlePath, 'utf-8');
  const workingStamp = STAMP_RE.exec(headOf(workingText))?.[1];
  if (!workingStamp) {
    fail('❌ 工作区 bundle 缺少源码指纹（@zh-src-hash）—— 请重新 build');
  }
  let committed;
  try {
    committed = execFileSync('git', ['show', `HEAD:${relBundlePath}`], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    console.error(`❌ 无法读取 HEAD 中的 ${relBundlePath}（git 不可用或文件未入库）`);
    process.exit(2);
  }
  const committedStamp = STAMP_RE.exec(headOf(committed))?.[1];
  if (!committedStamp) {
    fail('❌ 已提交的 bundle 没有源码指纹（旧产物）—— 请重新 build 并提交');
  }
  if (workingStamp !== committedStamp) {
    fail(
      [
        '❌ 已提交的 CLI bundle 与当前源码不一致（产物过期）',
        `   源码指纹（工作区构建）：${workingStamp}`,
        `   已提交产物指纹：      ${committedStamp}`,
        '   修复：pnpm --filter zhshield-cli build && git add packages/cli/dist/zhshield.js',
        '   （不修就等于让 GitHub Action / npx 用户继续跑旧代码）',
      ].join('\n'),
    );
  }
  const files = FILES_RE.exec(headOf(workingText))?.[1];
  console.log(`✅ CLI bundle 与源码一致（指纹 ${workingStamp}${files ? `，覆盖 ${files} 个源文件` : ''}）`);
}

main();
