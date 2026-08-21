/**
 * 锁文件完整性校验器（lockfile-verifier.ts）
 *
 * 离线静态校验项目锁文件与清单声明的一致性：
 * - 探测锁文件类型（npm / pnpm / yarn / pip）
 * - 对比清单声明范围与锁文件锁定版本（手写 semver 范围匹配器，零新依赖）
 * - 检测完整性字段缺失 / 校验和异常
 *
 * 零网络请求、不执行安装命令；解析失败按缺失/已修改处理，绝不抛异常。
 */
import * as fs from 'fs';
import * as path from 'path';
import { load as loadYaml } from 'js-yaml';

/** 锁文件校验器契约：离线静态校验，不联网 */
export interface LockfileVerifier {
  verify(projectRoot: string, options?: LockfileVerifierOptions): Promise<LockfileVerification>;
}

/** 校验选项（当前仅支持完整性基线比对） */
export interface LockfileVerifierOptions {
  /** 期望的完整性基线：nodeId（name@version）→ 期望 integrity，与锁文件实际值比对 */
  expectedIntegrity?: Record<string, string>;
}

/** 锁文件校验结果 */
export interface LockfileVerification {
  /** clean：全部声明满足且完整性通过；modified：存在不一致；missing：未发现锁文件 */
  status: 'clean' | 'modified' | 'missing';
  /** 命中的锁文件绝对路径（status 为 missing 时缺省） */
  lockfilePath?: string;
  /** 声明范围与锁定版本不一致的直接依赖明细 */
  diffs: LockfileDiff[];
  /** 完整性异常描述（缺失 / 校验和不匹配） */
  integrityFailures: string[];
}

/** 单个直接依赖的声明-锁定版本差异 */
export interface LockfileDiff {
  name: string;
  /** 清单声明的版本范围，如 '^4.17.21' */
  declaredVersion: string;
  /** 锁文件锁定的实际版本，如 '4.17.21'；未在锁文件中出现时为 '' */
  lockedVersion: string;
}

/** 判断值是否为普通对象（非 null、非数组） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 安全读取 JSON 文件；解析失败返回 null */
function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

/** 安全读取 YAML 文件；解析失败返回 null */
function readYamlSafe(filePath: string): unknown {
  try {
    return loadYaml(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** 安全读取文本文件；读取失败返回 null */
function readTextSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ────────────────────────────── semver 范围匹配（手写实现，零依赖） ──────────────────────────────

/** 解析后的版本号：主/次/修订数值 + 预发布标识 */
interface ParsedVersion {
  nums: [number, number, number];
  pre: string;
}

const ZERO: ParsedVersion = { nums: [0, 0, 0], pre: '' };

/** 解析完整版本号 '1.2.3-beta.1' → { nums, pre }；无法解析返回 null */
function parseVersion(input: string): ParsedVersion | null {
  const m = input.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { nums: [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? '' };
}

/** 比较 [major, minor, patch] 数值部分 */
function compareCore(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] < b.nums[i] ? -1 : 1;
  }
  return 0;
}

/** 完整比较：数值相等时预发布 < 正式版 */
function compareFull(a: ParsedVersion, b: ParsedVersion): number {
  const c = compareCore(a, b);
  if (c !== 0) return c;
  if (a.pre === '' && b.pre !== '') return 1;
  if (a.pre !== '' && b.pre === '') return -1;
  if (a.pre === b.pre) return 0;
  const ap = a.pre.split('.');
  const bp = b.pre.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn) return -1; // 数字标识 < 字母标识（semver 规则）
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** 解析部分版本 '1.2.x' / '1.2' / '1' → 已确定的数值段数量 */
function parsePartial(spec: string): number[] | null {
  const m = spec.match(/^(\d+)(?:\.(\d+|\*|x|X))?(?:\.(\d+|\*|x|X))?$/);
  if (!m) return null;
  const nums: number[] = [Number(m[1])];
  if (m[2] !== undefined && !/^[xX*]$/.test(m[2])) nums.push(Number(m[2]));
  if (m[3] !== undefined && !/^[xX*]$/.test(m[3])) nums.push(Number(m[3]));
  return nums;
}

/** 将部分版本填零为下界 */
function toLowerBound(nums: number[]): ParsedVersion {
  return { nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre: '' };
}

/** 部分版本满足判定：'1.2.x' 命中任意 1.2.*；'1.2' 视为 1.2.x；'1' 视为 1.x */
function partialSatisfies(ver: ParsedVersion, spec: string): boolean {
  const nums = parsePartial(spec);
  if (!nums) return false;
  if (compareCore(ver, toLowerBound(nums)) < 0) return false;
  const hi = nums.length === 1 ? [nums[0] + 1, 0, 0] : nums.length === 2 ? [nums[0], nums[1] + 1, 0] : [nums[0], nums[1], nums[2] + 1];
  return compareCore(ver, { nums: [hi[0], hi[1], hi[2]], pre: '' }) < 0;
}

/** ^ 范围：^1.2.3 → >=1.2.3 <2.0.0；^0.2.3 → >=0.2.3 <0.3.0；^0.0.3 → >=0.0.3 <0.0.4 */
function caretSatisfies(ver: ParsedVersion, spec: string): boolean {
  const nums = parsePartial(spec);
  if (!nums) return false;
  if (compareFull(ver, toLowerBound(nums)) < 0) return false;
  let hi: [number, number, number];
  if ((nums[0] ?? 0) !== 0) hi = [nums[0] + 1, 0, 0];
  else if ((nums[1] ?? 0) !== 0) hi = [0, nums[1] + 1, 0];
  else hi = [0, 0, (nums[2] ?? 0) + 1];
  return compareCore(ver, { nums: hi, pre: '' }) < 0;
}

/** ~ 范围：~1.2.3 → >=1.2.3 <1.3.0；~1.2 → >=1.2.0 <1.3.0；~1 → >=1.0.0 <2.0.0 */
function tildeSatisfies(ver: ParsedVersion, spec: string): boolean {
  const nums = parsePartial(spec);
  if (!nums) return false;
  if (compareFull(ver, toLowerBound(nums)) < 0) return false;
  const hi = nums.length >= 2 ? [nums[0], nums[1] + 1, 0] : [nums[0] + 1, 0, 0];
  return compareCore(ver, { nums: [hi[0], hi[1], hi[2]], pre: '' }) < 0;
}

const COMPARATOR_OP_RE = /^(>=|<=|>|<|===|==|=|~|\^)?(.+)$/;

/** 单比较符判定（如 '>=1.2.3'、'^4.17.21'、'1.2.x'、'*'） */
function satisfiesComparator(ver: ParsedVersion, token: string): boolean {
  const m = token.trim().match(COMPARATOR_OP_RE);
  if (!m) return false;
  const op = m[1] ?? '';
  const spec = m[2].trim();
  if (spec === '' || spec === '*' || spec === 'latest') return true;

  if (op === '^') return caretSatisfies(ver, spec);
  if (op === '~') return tildeSatisfies(ver, spec);

  if (op === '') {
    // 裸版本：完整 x.y.z 精确匹配；部分版本按 x.y / x 区间处理
    const full = parseVersion(spec);
    if (full && /^(\d+\.){2}\d+$/.test(spec)) return compareFull(ver, full) === 0;
    return partialSatisfies(ver, spec);
  }

  const target = parseVersion(spec);
  if (!target) {
    // '>=1.2' 这类部分版本按填零下界比较
    if (op === '>=' || op === '>') {
      const lower = toLowerBound(parsePartial(spec) ?? []);
      return op === '>=' ? compareFull(ver, lower) >= 0 : compareFull(ver, lower) > 0;
    }
    return false;
  }
  switch (op) {
    case '>=': return compareFull(ver, target) >= 0;
    case '<=': return compareFull(ver, target) <= 0;
    case '>': return compareFull(ver, target) > 0;
    case '<': return compareFull(ver, target) < 0;
    case '=':
    case '==':
    case '===': return compareFull(ver, target) === 0;
    default: return false;
  }
}

/** 一个备选集合（&& 关系）：逗号/空白分隔的比较符全部满足才成立 */
function satisfiesAlternative(ver: ParsedVersion, alt: string): boolean {
  // 预发布版本仅当范围本身带预发布标识时才可能满足（npm 语义）
  if (ver.pre !== '' && !alt.includes('-')) return false;
  const hyphen = alt.match(/^\s*(\S+)\s+-\s+(\S+)\s*$/);
  if (hyphen) {
    const lo = parseVersion(hyphen[1]) ?? ZERO;
    const hi = parseVersion(hyphen[2]) ?? ZERO;
    return compareFull(ver, lo) >= 0 && compareFull(ver, hi) <= 0;
  }
  const tokens = alt.split(/[\s,]+/).filter((t) => t.length > 0);
  return tokens.every((token) => satisfiesComparator(ver, token));
}

/** 版本是否满足声明范围（支持 ^ ~ >= <= > < = == 精确、x 通配、连字符、|| 与 && 组合） */
function satisfiesVersion(version: string, range: string): boolean {
  const ver = parseVersion(version);
  if (!ver) return false;
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'latest') return true;
  return trimmed.split('||').some((alt) => satisfiesAlternative(ver, alt));
}

// ────────────────────────────── 锁文件 / 清单解析 ──────────────────────────────

/** 从版本约束提取精确版本：'==2.3.2' → '2.3.2'；'>=2.0' → '2.0' */
function versionFromConstraint(constraint: string): string {
  const trimmed = constraint.trim();
  const first = trimmed.split(',')[0].trim();
  const exact = first.match(/^(?:==|===)\s*(.+)$/);
  if (exact) return exact[1].trim();
  return first.replace(/^[^0-9]*/, '').trim();
}

/** package.json 声明范围（dependencies + devDependencies） */
function readDeclaredRanges(projectRoot: string, failures: string[]): Map<string, string> {
  const declared = new Map<string, string>();
  const data = readJsonSafe(path.join(projectRoot, 'package.json'));
  if (!data) {
    failures.push('缺少可解析的 package.json，无法核对声明范围');
    return declared;
  }
  for (const key of ['dependencies', 'devDependencies'] as const) {
    const section = data[key];
    if (!isRecord(section)) continue;
    for (const [name, range] of Object.entries(section)) {
      if (typeof range === 'string') declared.set(name, range);
    }
  }
  return declared;
}

/** npm package-lock.json（v1 / v2 / v3）→ 声明范围 / 锁定版本 / 完整性 */
function parseNpmLock(projectRoot: string, lockfilePath: string): { declared: Map<string, string>; locked: Map<string, string>; integrity: Map<string, string>; failures: string[] } {
  const failures: string[] = [];
  const declared = readDeclaredRanges(projectRoot, failures);
  const locked = new Map<string, string>();
  const integrity = new Map<string, string>();

  const lock = readJsonSafe(lockfilePath);
  if (!lock) {
    failures.push('package-lock.json 解析失败，无法校验');
    return { declared, locked, integrity, failures };
  }

  const lockfileVersion = lock.lockfileVersion;
  const isV1 =
    lockfileVersion === 1 ||
    (lockfileVersion === undefined && isRecord(lock.dependencies) && !isRecord(lock.packages));

  if (isV1) {
    // v1：dependencies 顶层即直接依赖（含 integrity）
    const deps = lock.dependencies;
    if (isRecord(deps)) {
      for (const [name, meta] of Object.entries(deps)) {
        if (!isRecord(meta)) continue;
        const version = typeof meta.version === 'string' ? meta.version : '';
        if (version === '') continue;
        locked.set(name, version);
        const integrityValue = typeof meta.integrity === 'string' ? meta.integrity : '';
        if (integrityValue === '' && typeof meta.resolved !== 'string') {
          failures.push(`[npm] ${name}@${version} 缺少 integrity/resolved 完整性字段`);
        } else {
          integrity.set(`${name}@${version}`, integrityValue || (typeof meta.resolved === 'string' ? meta.resolved : ''));
        }
      }
    }
    return { declared, locked, integrity, failures };
  }

  // v2/v3：packages 映射，直接依赖取 node_modules/<name>
  const PACKAGE_KEY_RE = /^node_modules\/(@[^/]+\/[^/]+|[^/]+)/;
  const packages = lock.packages;
  if (!isRecord(packages)) {
    failures.push('package-lock.json packages 区块缺失，无法校验');
    return { declared, locked, integrity, failures };
  }
  for (const [key, meta] of Object.entries(packages)) {
    const m = key.match(PACKAGE_KEY_RE);
    if (!m) continue;
    if (!isRecord(meta)) continue;
    const name = m[1];
    const version = typeof meta.version === 'string' ? meta.version : '';
    if (version === '') continue;
    if (!locked.has(name)) locked.set(name, version);
    const integrityValue = typeof meta.integrity === 'string' ? meta.integrity : '';
    if (integrityValue === '') {
      failures.push(`[npm] ${name}@${version} 缺少 integrity 完整性字段`);
    } else {
      integrity.set(`${name}@${version}`, integrityValue);
    }
  }
  return { declared, locked, integrity, failures };
}

/** pnpm-lock.yaml → importers 声明范围 + packages 完整性 */
function parsePnpmLock(projectRoot: string, lockfilePath: string): { declared: Map<string, string>; locked: Map<string, string>; integrity: Map<string, string>; failures: string[] } {
  const failures: string[] = [];
  const declared = new Map<string, string>();
  const locked = new Map<string, string>();
  const integrity = new Map<string, string>();

  if (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
    failures.push('缺少 package.json 清单');
  }

  const data = readYamlSafe(lockfilePath);
  if (!isRecord(data)) {
    failures.push('pnpm-lock.yaml 解析失败，无法校验');
    return { declared, locked, integrity, failures };
  }

  const PNPM_PACKAGE_KEY_RE = /^\/?(@[^/]+\/[^/]+|[^/@]+)@(.+)$/;
  const packages = data.packages;
  if (isRecord(packages)) {
    for (const [key, meta] of Object.entries(packages)) {
      const m = key.match(PNPM_PACKAGE_KEY_RE);
      if (!m) continue;
      if (!isRecord(meta)) continue;
      const name = m[1];
      const version = m[2].split('(')[0];
      if (!version) continue;
      const resolution = isRecord(meta.resolution) ? meta.resolution : undefined;
      const integrityValue =
        typeof resolution?.integrity === 'string'
          ? resolution.integrity
          : typeof meta.integrity === 'string'
            ? meta.integrity
            : '';
      if (integrityValue === '') {
        failures.push(`[pnpm] ${name}@${version} 缺少 resolution.integrity 完整性字段`);
      } else {
        integrity.set(`${name}@${version}`, integrityValue);
      }
    }
  }

  const importers = data.importers;
  if (isRecord(importers)) {
    const rootImporter = importers['.'] ?? Object.values(importers)[0];
    if (isRecord(rootImporter)) {
      for (const sectionKey of ['dependencies', 'devDependencies'] as const) {
        const section = rootImporter[sectionKey];
        if (!isRecord(section)) continue;
        for (const [name, meta] of Object.entries(section)) {
          if (!isRecord(meta)) continue;
          const specifier = typeof meta.specifier === 'string' ? meta.specifier : '';
          const version = typeof meta.version === 'string' ? meta.version.split('(')[0] : '';
          if (version === '') continue;
          declared.set(name, specifier);
          locked.set(name, version);
        }
      }
    }
  }
  return { declared, locked, integrity, failures };
}

/** yarn.lock v1 块 */
interface YarnBlock {
  keys: string[];
  fields: Map<string, string>;
}

/** yarn 块键解析：name@range → { name, range }（支持 @scope/name@range） */
const YARN_KEY_RE = /^(@[^/]+\/)?([^@]+)@(.*)$/;

/** 解析 yarn.lock v1 块式格式 */
function parseYarnLock(content: string): YarnBlock[] {
  const blocks: YarnBlock[] = [];
  let current: YarnBlock | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    if (indent === 0 && trimmed.endsWith(':')) {
      let keysText = trimmed.slice(0, -1).trim();
      if (keysText.length >= 2 && keysText.startsWith('"') && keysText.endsWith('"')) {
        keysText = keysText.slice(1, -1);
      }
      current = { keys: keysText.split(',').map((k) => k.trim()), fields: new Map() };
      blocks.push(current);
      continue;
    }
    if (current) {
      const m = trimmed.match(/^(\S+)\s+(.+)$/);
      if (m) {
        let value = m[2].trim();
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        current.fields.set(m[1], value);
      }
    }
  }
  return blocks;
}

/** yarn.lock v1 → package.json 声明范围 + 块锁定版本 */
function parseYarnLockFile(projectRoot: string, lockfilePath: string): { declared: Map<string, string>; locked: Map<string, string>; integrity: Map<string, string>; failures: string[] } {
  const failures: string[] = [];
  const declared = readDeclaredRanges(projectRoot, failures);
  const locked = new Map<string, string>();
  const integrity = new Map<string, string>();

  const content = readTextSafe(lockfilePath);
  if (content === null) {
    failures.push('yarn.lock 读取失败，无法校验');
    return { declared, locked, integrity, failures };
  }

  for (const block of parseYarnLock(content)) {
    const version = block.fields.get('version');
    if (!version) continue;
    for (const key of block.keys) {
      const m = key.trim().match(YARN_KEY_RE);
      if (!m) continue;
      const scope = m[1] ?? '';
      const name = `${scope}${m[2]}`;
      if (!locked.has(name)) locked.set(name, version);
      const integrityValue = block.fields.get('integrity') ?? '';
      if (integrityValue === '') {
        failures.push(`[yarn] ${name}@${version} 缺少 integrity 完整性字段`);
      } else if (!integrity.has(`${name}@${version}`)) {
        integrity.set(`${name}@${version}`, integrityValue);
      }
    }
  }
  return { declared, locked, integrity, failures };
}

/** poetry 依赖约束值解析：'^2.0' / '{ version = "^2.0", ... }' → 版本约束字符串 */
function parsePoetryConstraint(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) {
    const m = trimmed.match(/version\s*=\s*["']([^"']+)["']/);
    return m ? m[1] : '';
  }
  let result = trimmed;
  if (
    result.length >= 2 &&
    (result.startsWith('"') || result.startsWith("'")) &&
    (result.endsWith('"') || result.endsWith("'"))
  ) {
    result = result.slice(1, -1);
  }
  return result;
}

/** pyproject.toml：[project].dependencies（PEP 621）与 [tool.poetry.dependencies] / [tool.uv.dependencies] */
function parsePyproject(content: string): Map<string, string> {
  const declared = new Map<string, string>();
  const sections = content.split(/^\s*\[/m);
  for (const section of sections) {
    const header = section.match(/^([^\]]+)\]/);
    if (!header) continue;
    const sectionName = header[1].trim().toLowerCase();
    if (sectionName === 'project') {
      const depsBlock = section.match(/dependencies\s*=\s*\[/);
      if (!depsBlock) continue;
      const block = section.slice(section.indexOf(depsBlock[0]) + depsBlock[0].length);
      for (const m of block.matchAll(/"([^"]+)"/g)) {
        const entry = m[1].replace(/\[.*?\]/g, '');
        const name = entry.match(/^[A-Za-z0-9_.-]+/)?.[0];
        if (!name) continue;
        const rest = entry.slice(name.length).trim();
        declared.set(name, rest);
      }
    } else if (sectionName === 'tool.poetry.dependencies' || sectionName === 'tool.uv.dependencies') {
      for (const line of section.split(/\r?\n/)) {
        if (line.trim().startsWith('[')) continue;
        const key = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
        if (!key) continue;
        const name = key[1];
        if (name === 'python') continue;
        declared.set(name, parsePoetryConstraint(line.slice(line.indexOf('=') + 1)));
      }
    }
  }
  return declared;
}

/** poetry.lock：[[package]] 块 → name / version / 是否带 [files] 哈希 */
function parsePoetryLock(content: string): Array<{ name: string; version: string; hasHashes: boolean }> {
  const packages: Array<{ name: string; version: string; hasHashes: boolean }> = [];
  for (const block of content.split(/^\s*\[\[package\]\]\s*$/m)) {
    const nameMatch = block.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    const versionMatch = block.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
    if (!nameMatch || !versionMatch) continue;
    const idx = block.indexOf('[files]');
    const filesSection = idx >= 0 ? block.slice(idx) : '';
    const hasHashes = filesSection !== '' && /\bhash\s*=/.test(filesSection);
    packages.push({ name: nameMatch[1], version: versionMatch[1], hasHashes });
  }
  return packages;
}

/** pyproject.toml + poetry.lock → 声明范围 + 锁定版本 */
function parsePoetryProject(projectRoot: string, lockfilePath: string): { declared: Map<string, string>; locked: Map<string, string>; integrity: Map<string, string>; failures: string[] } {
  const failures: string[] = [];
  const declared = new Map<string, string>();
  const locked = new Map<string, string>();
  const integrity = new Map<string, string>();

  const pyprojectContent = readTextSafe(path.join(projectRoot, 'pyproject.toml'));
  if (pyprojectContent === null) {
    failures.push('缺少可解析的 pyproject.toml，无法核对声明范围');
  } else {
    for (const [name, range] of parsePyproject(pyprojectContent)) declared.set(name, range);
  }

  const content = readTextSafe(lockfilePath);
  if (content === null) {
    failures.push('poetry.lock 读取失败，无法校验');
    return { declared, locked, integrity, failures };
  }
  for (const pkg of parsePoetryLock(content)) {
    if (!locked.has(pkg.name)) locked.set(pkg.name, pkg.version);
    if (!pkg.hasHashes) {
      failures.push(`[pip] ${pkg.name}@${pkg.version} 缺少 [files] 哈希校验字段`);
    }
  }
  return { declared, locked, integrity, failures };
}

/** Pipfile.lock：default / develop 区块，version 为声明范围，hashes 为完整性 */
function parsePipfileLockFile(lockfilePath: string): { declared: Map<string, string>; locked: Map<string, string>; integrity: Map<string, string>; failures: string[] } {
  const failures: string[] = [];
  const declared = new Map<string, string>();
  const locked = new Map<string, string>();
  const integrity = new Map<string, string>();

  const data = readJsonSafe(lockfilePath);
  if (!data) {
    failures.push('Pipfile.lock 解析失败，无法校验');
    return { declared, locked, integrity, failures };
  }
  for (const section of ['default', 'develop'] as const) {
    const sectionData = data[section];
    if (!isRecord(sectionData)) continue;
    for (const [name, meta] of Object.entries(sectionData)) {
      if (name === '_meta') continue;
      if (!isRecord(meta)) continue;
      const range = typeof meta.version === 'string' ? meta.version : '';
      const lockedVersion = versionFromConstraint(range);
      declared.set(name, range);
      if (lockedVersion !== '') locked.set(name, lockedVersion);
      const hashes = meta.hashes;
      if (!Array.isArray(hashes) || hashes.length === 0) {
        failures.push(`[pip] ${name}@${lockedVersion} 缺少 hashes 哈希字段`);
      }
    }
  }
  return { declared, locked, integrity, failures };
}

// ────────────────────────────── 校验器实现 ──────────────────────────────

/** 各生态解析结果统一形态 */
interface ParsedLockfile {
  declared: Map<string, string>;
  locked: Map<string, string>;
  integrity: Map<string, string>;
  failures: string[];
}

/** 锁文件校验器具体实现：离线静态，绝不抛异常 */
export class LockfileVerifierImpl implements LockfileVerifier {
  async verify(projectRoot: string, options?: LockfileVerifierOptions): Promise<LockfileVerification> {
    // 探测锁文件（与图谱构建器探测优先级一致：pnpm → npm → yarn → poetry → Pipfile）
    const candidates: Array<{ kind: string; file: string; parser: () => ParsedLockfile }> = [
      { kind: 'pnpm', file: 'pnpm-lock.yaml', parser: () => parsePnpmLock(projectRoot, path.join(projectRoot, 'pnpm-lock.yaml')) },
      { kind: 'npm', file: 'package-lock.json', parser: () => parseNpmLock(projectRoot, path.join(projectRoot, 'package-lock.json')) },
      { kind: 'yarn', file: 'yarn.lock', parser: () => parseYarnLockFile(projectRoot, path.join(projectRoot, 'yarn.lock')) },
      { kind: 'poetry', file: 'poetry.lock', parser: () => parsePoetryProject(projectRoot, path.join(projectRoot, 'poetry.lock')) },
      { kind: 'pipfile', file: 'Pipfile.lock', parser: () => parsePipfileLockFile(path.join(projectRoot, 'Pipfile.lock')) },
    ];

    const found = candidates.find((c) => fs.existsSync(path.join(projectRoot, c.file)));
    if (!found) {
      // 无锁文件（含无任何清单）→ missing
      return { status: 'missing', diffs: [], integrityFailures: [] };
    }

    const lockfilePath = path.join(projectRoot, found.file);
    const parsed = found.parser();
    const integrityFailures = [...parsed.failures];

    // 完整性基线比对（options.expectedIntegrity）
    if (options?.expectedIntegrity) {
      for (const [nodeId, expected] of Object.entries(options.expectedIntegrity)) {
        const actual = parsed.integrity.get(nodeId);
        if (actual !== undefined && actual !== expected) {
          integrityFailures.push(`[${found.kind}] ${nodeId} 校验和不匹配：期望 ${expected}，实际 ${actual}`);
        }
      }
    }

    // 声明范围 vs 锁定版本
    const diffs: LockfileDiff[] = [];
    for (const [name, range] of parsed.declared) {
      const lockedVersion = parsed.locked.get(name);
      if (lockedVersion === undefined) {
        diffs.push({ name, declaredVersion: range, lockedVersion: '' });
      } else if (!satisfiesVersion(lockedVersion, range)) {
        diffs.push({ name, declaredVersion: range, lockedVersion });
      }
    }

    const status: LockfileVerification['status'] =
      diffs.length > 0 || integrityFailures.length > 0 ? 'modified' : 'clean';

    return { status, lockfilePath, diffs, integrityFailures };
  }
}

/** 便捷入口：同步语义的异步包装（实现为单例类实例方法） */
export const lockfileVerifier: LockfileVerifier = new LockfileVerifierImpl();
