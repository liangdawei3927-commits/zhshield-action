/**
 * 环境一致性检查 —— 版本解析与漂移检查（env-consistency-versions.ts）
 *
 * 由 env-consistency.ts 拆出，覆盖两类偏差：
 * - lockfile-drift：package.json 声明范围 vs 锁文件解析版本（不满足范围 → error）
 * - runtime-version：.nvmrc / .node-version / engines.node / .tool-versions 相互矛盾（矛盾 → error，单源 → info）
 *
 * 纯离线静态比对；解析失败按缺失处理，绝不抛异常。
 */
import * as fs from 'fs';
import { safeJoin } from '@zh/shared';
import {
  isRecord,
  readJsonSafe,
  readYamlSafe,
  readTextSafe,
  collectManifestRanges,
  parseYarnBlockKeys,
  readPnpmImporterEntries,
  forEachYarnLine,
  NEWLINE_RE,
} from '../lockfile-utils';
import type { EnvEntry } from './env-consistency-types';

// ────────────────────────────── 模块级正则常量（避免每次调用重编译） ──────────────────────────────

/** v 前缀剥离（不区分大小写） */
const V_PREFIX_RE = /^v/i;
/** semver major.minor.patch 捕获（前缀不限） */
const SEMVER_MMP_RE = /^(\d+)\.(\d+)\.(\d+)/;
/** 精确版本匹配 x.y.z */
const EXACT_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
/** ^ 范围匹配 */
const CARET_RANGE_RE = /^\^(\d+)\.(\d+)\.(\d+)$/;
/** ~ 范围匹配 */
const TILDE_RANGE_RE = /^~(\d+)\.(\d+)\.(\d+)$/;
/** 带前缀的版本匹配 */
const PREFIXED_VERSION_RE = /^[v~^]*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
/** npm package-lock.json packages 键 */
const NPM_PACKAGE_KEY_RE = /^node_modules\/(@[^/]+\/[^/]+|[^/]+)/;
/** yarn 包名提取 'name@' */
const YARN_PKG_NAME_RE = /^(@[^/]+\/)?([^@]+)@/;
/** 空白拆分 */
const WHITESPACE_RE = /\s+/;

/** 去除版本号前后空白与首尾 v 前缀（'  v18.20.2\n' → '18.20.2'） */
function normalizeVersion(raw: string): string {
  return raw.trim().replace(V_PREFIX_RE, '');
}

/**
 * 判断锁定版本是否满足 package.json 声明范围（仅离线静态近似）：
 * - 精确版本 / ^x.y.z / ~x.y.z：比较主次补丁数字
 * - 通配（* / x / latest / workspace:*）：视为满足
 */
function satisfiesRange(range: string, version: string): boolean {
  const r = range.trim();
  if (r === '' || r === '*' || r === 'x' || r === 'latest' || r.includes('workspace:')) return true;
  const m = version.match(SEMVER_MMP_RE);
  if (!m) return true;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const exact = r.match(EXACT_VERSION_RE);
  if (exact) return matchesExact(exact, major, minor, patch);
  const caret = r.match(CARET_RANGE_RE);
  if (caret) return matchesCaret(caret, major, minor, patch);
  const tilde = r.match(TILDE_RANGE_RE);
  if (tilde) return matchesTilde(tilde, major, minor, patch);
  const star = r.match(PREFIXED_VERSION_RE);
  if (star) return matchesPrefixed(star, major, minor, patch);
  return true;
}

/** 精确版本 x.y.z 匹配 */
function matchesExact(
  exact: RegExpMatchArray,
  major: number,
  minor: number,
  patch: number,
): boolean {
  return exact[1] === String(major) && exact[2] === String(minor) && exact[3] === String(patch);
}

/** ^x.y.z 范围匹配 */
function matchesCaret(
  caret: RegExpMatchArray,
  major: number,
  minor: number,
  patch: number,
): boolean {
  const [cM, cm, cP] = [Number(caret[1]), Number(caret[2]), Number(caret[3])];
  if (cM !== major) return false;
  return cM > 0 ? minor >= cm : (minor === cm && patch >= cP) || minor > cm;
}

/** ~x.y.z 范围匹配 */
function matchesTilde(
  tilde: RegExpMatchArray,
  major: number,
  minor: number,
  patch: number,
): boolean {
  return Number(tilde[1]) === major && Number(tilde[2]) === minor && patch >= Number(tilde[3]);
}

/** 带前缀版本（v/~ /^ 前缀 + 1-3 段）匹配 */
function matchesPrefixed(
  star: RegExpMatchArray,
  major: number,
  minor: number,
  patch: number,
): boolean {
  const [sM, sm, sP] = [Number(star[1]), Number(star[2] ?? '0'), Number(star[3] ?? '0')];
  if (sM !== major) return false;
  if (star[2] === undefined) return true;
  if (sm !== minor) return false;
  if (star[3] === undefined) return true;
  return patch >= sP;
}

/** package.json 直接依赖声明：name → 范围 */
function readDeclaredDeps(pkgJson: Record<string, unknown>): Map<string, string> {
  return collectManifestRanges(pkgJson, [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ]);
}

/** npm 锁文件：packages 映射 + v1 dependencies 嵌套 → name → version */
function collectNpmVersions(lock: Record<string, unknown>): Map<string, string> {
  const versions = new Map<string, string>();
  const packages = lock.packages;
  if (isRecord(packages)) {
    for (const [key, meta] of Object.entries(packages)) {
      const m = key.match(NPM_PACKAGE_KEY_RE);
      if (!m) continue;
      if (!isRecord(meta)) continue;
      if (typeof meta.version !== 'string') continue;
      if (!versions.has(m[1])) versions.set(m[1], meta.version);
    }
  }
  const deps = lock.dependencies;
  if (isRecord(deps)) {
    const walk = (section: Record<string, unknown>): void => {
      for (const [name, meta] of Object.entries(section)) {
        if (!isRecord(meta)) continue;
        if (typeof meta.version === 'string' && !versions.has(name))
          versions.set(name, meta.version);
        const nested = meta.dependencies;
        if (isRecord(nested)) walk(nested);
      }
    };
    walk(deps);
  }
  return versions;
}

/** pnpm 锁文件：importers 直接依赖 → name → 锁定版本 */
function collectPnpmVersions(lock: Record<string, unknown>): Map<string, string> {
  const versions = new Map<string, string>();
  const entries = readPnpmImporterEntries(lock, [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ]);
  for (const entry of entries) {
    versions.set(entry.name, entry.version);
  }
  return versions;
}

/** yarn.lock v1 块式解析 → name → 锁定版本 */
function collectYarnVersions(content: string): Map<string, string> {
  const versions = new Map<string, string>();
  let currentName: string | null = null;
  forEachYarnLine(content, (trimmed, indent) => {
    if (indent === 0 && trimmed.endsWith(':')) {
      const first = parseYarnBlockKeys(trimmed)[0] ?? '';
      const m = first.match(YARN_PKG_NAME_RE);
      currentName = m ? `${m[1] ?? ''}${m[2]}` : null;
      return;
    }
    if (currentName && trimmed.startsWith('version ')) {
      let value = trimmed.slice('version'.length).trim();
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
        value = value.slice(1, -1);
      if (!versions.has(currentName)) versions.set(currentName, value);
      currentName = null;
    }
  });
  return versions;
}

/** 锁文件漂移检查：声明范围 vs 锁文件解析版本 */
export function checkLockfileDrift(
  projectRoot: string,
  pkgJson: Record<string, unknown> | null,
): EnvEntry[] {
  if (!pkgJson) return [];
  const declared = readDeclaredDeps(pkgJson);
  if (declared.size === 0) return [];

  const resolved = resolveLockfileVersions(projectRoot);
  if (!resolved) return [];

  return buildDriftEntries(declared, resolved);
}

/** 按优先级读取锁文件（pnpm → npm → yarn）并解析版本映射 */
function resolveLockfileVersions(projectRoot: string): Map<string, string> | null {
  const pnpmPath = safeJoin(projectRoot, 'pnpm-lock.yaml');
  const npmPath = safeJoin(projectRoot, 'package-lock.json');
  const yarnPath = safeJoin(projectRoot, 'yarn.lock');

  if (fs.existsSync(pnpmPath)) {
    const lock = readYamlSafe(pnpmPath);
    return isRecord(lock) ? collectPnpmVersions(lock) : null;
  }
  if (fs.existsSync(npmPath)) {
    const lock = readJsonSafe(npmPath);
    return lock ? collectNpmVersions(lock) : null;
  }
  if (fs.existsSync(yarnPath)) {
    const content = readTextSafe(yarnPath);
    return content !== null ? collectYarnVersions(content) : null;
  }
  return null;
}

/** 对比声明范围与锁定版本，产出漂移条目 */
function buildDriftEntries(
  declared: Map<string, string>,
  resolved: Map<string, string>,
): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const [name, range] of declared) {
    const locked = resolved.get(name);
    if (locked === undefined) continue;
    if (satisfiesRange(range, locked)) continue;
    entries.push({
      kind: 'lockfile-drift',
      name,
      expected: range,
      actual: locked,
      severity: 'error',
      detail: `package.json 声明 ${name}@${range}，锁文件锁定 ${locked}，不在声明范围内`,
    });
  }
  return entries;
}

/** 运行时版本源：来源名称 + 原始声明 */
export interface RuntimeSource {
  source: string;
  value: string;
}

/** 收集运行时版本来源：.nvmrc / .node-version / engines.node / .tool-versions */
export function collectRuntimeSources(
  projectRoot: string,
  pkgJson: Record<string, unknown> | null,
): RuntimeSource[] {
  const sources: RuntimeSource[] = [];

  for (const file of ['.nvmrc', '.node-version']) {
    const content = readTextSafe(safeJoin(projectRoot, file));
    if (content === null) continue;
    const firstLine = content.split(NEWLINE_RE).find((line) => line.trim() !== '');
    if (firstLine) sources.push({ source: file, value: normalizeVersion(firstLine) });
  }

  if (pkgJson) {
    const engines = pkgJson.engines;
    if (isRecord(engines) && typeof engines.node === 'string') {
      sources.push({ source: 'package.json engines.node', value: engines.node.trim() });
    }
  }

  const toolVersions = readTextSafe(safeJoin(projectRoot, '.tool-versions'));
  if (toolVersions !== null) {
    for (const rawLine of toolVersions.split(NEWLINE_RE)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const parts = line.split(WHITESPACE_RE);
      if (parts[0] === 'nodejs' && parts[1]) {
        sources.push({ source: '.tool-versions (nodejs)', value: normalizeVersion(parts[1]) });
      }
    }
  }

  return sources;
}

/** 运行时版本一致性检查：多源矛盾 → error；仅单源 → info */
export function checkRuntimeVersion(
  projectRoot: string,
  pkgJson: Record<string, unknown> | null,
): EnvEntry[] {
  const sources = collectRuntimeSources(projectRoot, pkgJson);
  if (sources.length === 0) return [];

  const entries: EnvEntry[] = [];
  const first = sources[0];

  if (sources.length === 1) {
    entries.push({
      kind: 'runtime-version',
      name: 'node',
      expected: `${first.source}: ${first.value}`,
      actual: '（仅有此一处来源）',
      severity: 'info',
      detail: `运行时版本仅由 ${first.source} 声明（${first.value}），缺少其他来源交叉验证`,
    });
    return entries;
  }

  for (let i = 1; i < sources.length; i++) {
    const source = sources[i];
    if (normalizeVersion(source.value) === normalizeVersion(first.value)) continue;
    entries.push({
      kind: 'runtime-version',
      name: 'node',
      expected: `${first.source}: ${first.value}`,
      actual: `${source.source}: ${source.value}`,
      severity: 'error',
      detail: `${first.source} 与 ${source.source} 声明的 Node 版本不一致`,
    });
  }
  return entries;
}
