/**
 * npm 恶意包特征库（npm-threat-scanner.ts）
 *
 * 对 package-lock.json 做供应链投毒检测：
 *   1. 精确黑名单 — 已知恶意 / 仿冒包名（已被社区确认并移除的包）
 *   2. 仿冒检测 — 与高频流行包名做编辑距离比对（typosquatting）
 * 纯静态分析，无需联网；产出 type='supply-chain' 的 MalwareItem。
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { load as loadYaml } from 'js-yaml';
import type { MalwareItem } from './types';

/** 已知恶意 / 仿冒 npm 包（社区确认，仅收录整名即为恶意的包，不含版本投毒事件） */
const KNOWN_MALICIOUS_PACKAGES = new Set<string>([  'flatmap-stream',   // event-stream 供应链投毒（2018，已移除）
  'crossenv',         // cross-env 仿冒
  'jquery-dist',      // jquery typosquatting
  'lodahs',           // lodash typosquatting
  'loadash',          // lodash typosquatting
  'babelcli',         // babel 仿冒
  'db-json',          // json-server 仿冒
]);

/** 高频流行包名：仿冒检测基准，同时作为合法白名单（避免命中真实包） */
const KNOWN_POPULAR_PACKAGES = new Set<string>([
  'react', 'react-dom', 'lodash', 'express', 'axios', 'node-fetch', 'request',
  'async', 'chalk', 'debug', 'commander', 'jsonwebtoken', 'moment', 'mongoose',
  'uuid', 'ws', 'socket.io', 'next', 'vue', 'angular', 'webpack', 'gulp', 'grunt',
  'jquery', 'bootstrap', 'typescript', 'eslint', 'prettier', 'jest', 'mocha',
  'ioredis', 'mysql', 'mysql2', 'pg', 'dotenv', 'yargs', 'minimist', 'semver',
  'form-data', 'body-parser', 'cors', 'helmet', 'morgan', 'cookie-parser',
  'sqlite', 'sqlite3', 'redis', 'glob', 'rimraf', 'mkdirp', 'http-proxy',
  'undici', 'zod', 'dayjs', 'classnames', 'nanoid', 'tailwindcss', 'vitest',
]);

/** 编辑距离阈值：短包名更宽松（仿冒通常只差一两个字符） */
function typosquatThreshold(name: string): number {
  return name.length <= 8 ? 1 : 2;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = new Array<number>(n + 1).fill(0);
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[n];
}

/** lockfile v2/v3 packages 键中的包名：node_modules/<包名>（含 @scope/name 形式） */
const PACKAGE_KEY_RE = /^node_modules\/(@[^/]+\/[^/]+|[^/]+)/;
/** 剥离 scoped 包名前缀：@scope/name → name */
const SCOPED_NAME_RE = /^@[^/]+\//;
/** pnpm-lock.yaml v6+ packages 键中的包名：/<name>@<version> 或 /@scope/name@<version> */
const PNPM_PACKAGE_KEY_RE = /^\/(@[^/]+\/[^/]+|[^/]+)@/;

/** 提取 package-lock.json 中所有直接/间接包名（兼容 lockfile v1 与 v2/v3） */
function extractPackageNames(lock: unknown): string[] {
  const names = new Set<string>();
  if (!lock || typeof lock !== 'object') return [];

  const packages = (lock as { packages?: Record<string, unknown> }).packages;
  if (packages && typeof packages === 'object') {
    for (const key of Object.keys(packages)) {
      const m = key.match(PACKAGE_KEY_RE);
      if (m) names.add(m[1]);
    }
  }

  const deps = (lock as { dependencies?: Record<string, unknown> }).dependencies;
  if (deps && typeof deps === 'object') {
    collectV1Names(deps, names);
  }
  return [...names];
}

function collectV1Names(deps: Record<string, unknown>, names: Set<string>): void {
  for (const [name, meta] of Object.entries(deps)) {
    names.add(name);
    if (meta && typeof meta === 'object') {
      const nested = (meta as { dependencies?: Record<string, unknown> }).dependencies;
      if (nested && typeof nested === 'object') collectV1Names(nested, names);
    }
  }
}

/** 提取 pnpm-lock.yaml v6+ 中所有包名（packages 键的 /name@version 形式） */
function extractPnpmPackageNames(lock: unknown): string[] {
  const names = new Set<string>();
  if (!lock || typeof lock !== 'object') return [];

  const packages = (lock as { packages?: Record<string, unknown> }).packages;
  if (packages && typeof packages === 'object') {
    for (const key of Object.keys(packages)) {
      const m = key.match(PNPM_PACKAGE_KEY_RE);
      if (m) names.add(m[1]);
    }
  }

  const importers = (lock as { importers?: Record<string, unknown> }).importers;
  if (importers && typeof importers === 'object') {
    collectImporterDeps(importers, names);
  }
  return [...names];
}

/** pnpm-lock.yaml importers 区块：<workspace> → dependencies/devDependencies 直接依赖 */
function collectImporterDeps(importers: Record<string, unknown>, names: Set<string>): void {
  for (const importer of Object.values(importers)) {
    if (!importer || typeof importer !== 'object') continue;
    const deps = (importer as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    });
    for (const depMap of [deps.dependencies, deps.devDependencies]) {
      if (depMap && typeof depMap === 'object') {
        for (const name of Object.keys(depMap)) names.add(name);
      }
    }
  }
}

/** 扫描项目锁文件（pnpm-lock.yaml 优先，其次 package-lock.json），返回命中供应链威胁的 MalwareItem 列表 */
export async function scanNpmThreats(projectPath: string): Promise<MalwareItem[]> {
  const pnpmLockPath = path.join(projectPath, 'pnpm-lock.yaml');
  const npmLockPath = path.join(projectPath, 'package-lock.json');
  const isPnpm = fs.existsSync(pnpmLockPath);
  const lockPath = isPnpm ? pnpmLockPath : npmLockPath;
  if (!fs.existsSync(lockPath)) return [];

  let names: string[];
  try {
    if (isPnpm) {
      names = extractPnpmPackageNames(loadYaml(fs.readFileSync(pnpmLockPath, 'utf-8')));
    } else {
      names = extractPackageNames(JSON.parse(fs.readFileSync(npmLockPath, 'utf-8')));
    }
  } catch {
    return [];
  }

  const items: MalwareItem[] = [];
  for (const name of names) {
    const short = name.startsWith('@') ? name.replace(SCOPED_NAME_RE, '') : name;
    const isScoped = name.startsWith('@');

    if (KNOWN_MALICIOUS_PACKAGES.has(name)) {
      items.push(makeThreatItem(lockPath, name, {
        severity: 'critical',
        title: '已知恶意 npm 包（供应链投毒黑名单）',
        pattern: 'npm-threat-db',
        evidence: `${path.basename(lockPath)} 引用了黑名单包 ${name}`,
      }));
      continue;
    }

    if (isScoped || KNOWN_POPULAR_PACKAGES.has(short)) continue;

    const threshold = typosquatThreshold(short);
    for (const popular of KNOWN_POPULAR_PACKAGES) {
      const distance = levenshtein(short, popular);
      if (distance >= 1 && distance <= threshold) {
        items.push(makeThreatItem(lockPath, name, {
          severity: 'high',
          title: '疑似仿冒包（typosquatting）',
          pattern: `typosquat:${popular}:${distance}`,
          evidence: `包名 ${name} 与流行包 ${popular} 编辑距离为 ${distance}`,
        }));
        break;
      }
    }
  }
  return items;
}

function makeThreatItem(
  lockPath: string,
  name: string,
  meta: { severity: MalwareItem['severity']; title: string; pattern: string; evidence: string },
): MalwareItem {
  return {
    id: randomUUID(),
    type: 'supply-chain',
    severity: meta.severity,
    title: meta.title,
    description: `检测到供应链威胁：${name}`,
    file: lockPath,
    line: 0,
    pattern: meta.pattern,
    evidence: meta.evidence,
  };
}
