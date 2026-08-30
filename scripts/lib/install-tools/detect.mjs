/**
 * detect.mjs — 工具探测与版本检测
 *
 * 依赖: 仅 node 内置模块（node:fs/node:path/node:child_process），node 20+。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { IS_WIN, TOOLS_DIR } from './constants.mjs';

/** 探测 PATH（等价 command -v / where） */
export function findInPath(binName) {
  if (IS_WIN) {
    const res = spawnSync('where', [binName], { encoding: 'utf-8' });
    if (res.status === 0 && res.stdout.trim()) return res.stdout.trim().split(/\r?\n/)[0];
    return null;
  }
  const res = spawnSync('sh', ['-c', `command -v ${binName}`], { encoding: 'utf-8' });
  if (res.status === 0 && res.stdout.trim()) return res.stdout.trim().split('\n')[0];
  return null;
}

/** 运行 <bin> --version 并提取首个 semver 三元组 */
export function getToolVersion(binPath) {
  try {
    const res = spawnSync(binPath, ['--version'], { encoding: 'utf-8', timeout: 10000 });
    if (res.status !== 0) return null;
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    const m = out.match(/\d+\.\d+\.\d+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

export function versionsMatch(actual, expected) {
  if (!actual || !expected) return false;
  return actual.replace(/^v/, '').trim() === expected.replace(/^v/, '').trim();
}

/** npm 工具本地安装版本：直接读 ~/.zhshield/tools/<tool>/node_modules/<pkg>/package.json */
export function getNpmInstalledVersion(tool) {
  const pkgJson = join(TOOLS_DIR, tool.name, 'node_modules', tool.npm.package, 'package.json');
  try {
    return JSON.parse(readFileSync(pkgJson, 'utf-8')).version;
  } catch {
    return null;
  }
}

/** 工具是否支持 --version（ts-prune 等不支持，运行 --version 会触发分析） */
export function supportsVersionFlag(tool) {
  if (tool.install === 'npm') return tool.npm.versionFlag !== false;
  return true;
}

/** 递归查找解压目录中的目标二进制 */
export function findFileRecursive(dir, fileName) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      const found = findFileRecursive(p, fileName);
      if (found) return found;
    } else if (entry === fileName) {
      return p;
    }
  }
  return null;
}
