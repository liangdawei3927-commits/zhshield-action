import * as fs from 'node:fs';
import { load as loadYaml } from 'js-yaml';

/**
 * lockfile-utils — 锁文件解析的通用纯工具。
 *
 * 这些函数原先在 graph-builder / env-consistency / lockfile-verifier 中被
 * 逐字复制，现收敛为唯一实现，三处 import 复用，避免行为分叉。
 * 全部为无副作用、确定性的纯函数。
 */

// ────────────────────────────── 文件读取 / 解析（失败一律按缺失处理） ──────────────────────────────

/** 安全读取文本文件；读取失败返回 null（readTextSafe / readJsonSafe / readYamlSafe 共用） */
function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    // 无法读取时按缺失处理
    return null;
  }
}

/** 解析 JSON 文本并窄化为普通对象；解析失败或非普通对象返回 null */
function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(content);
    return isRecord(data) ? data : null;
  } catch {
    // 无法解析时按缺失处理
    return null;
  }
}

/** 解析 YAML 文本；解析失败返回 null */
function parseYamlSafe(content: string): unknown {
  try {
    return loadYaml(content);
  } catch {
    // 无法解析时按缺失处理
    return null;
  }
}

/** 判断值是否为普通对象（非 null、非数组） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 安全读取 JSON 文件；读取或解析失败返回 null */
export function readJsonSafe(filePath: string): Record<string, unknown> | null {
  const raw = readFileSafe(filePath);
  return raw === null ? null : parseJsonRecord(raw);
}

/** 安全读取 YAML 文件；读取或解析失败返回 null */
export function readYamlSafe(filePath: string): unknown {
  const raw = readFileSafe(filePath);
  return raw === null ? null : parseYamlSafe(raw);
}

/** 安全读取文本文件；读取失败返回 null */
export function readTextSafe(filePath: string): string | null {
  return readFileSafe(filePath);
}

// ────────────────────────────── 清单声明读取 ──────────────────────────────

/**
 * 读取 package.json 中指定区块的依赖声明：name → 范围。
 * 区块缺失 / 非普通对象 / 取值非字符串的条目一律跳过；区块顺序即写入顺序。
 */
export function collectManifestRanges(
  data: Record<string, unknown>,
  sectionKeys: readonly string[],
): Map<string, string> {
  const declared = new Map<string, string>();
  for (const key of sectionKeys) {
    const section = data[key];
    if (!isRecord(section)) continue;
    for (const [name, range] of Object.entries(section)) {
      if (typeof range === 'string') declared.set(name, range);
    }
  }
  return declared;
}

// ────────────────────────────── pnpm-lock.yaml ──────────────────────────────

/** pnpm-lock.yaml importers 区块中的单条直接依赖声明 */
export interface PnpmImporterEntry {
  /** 包名 */
  name: string;
  /** 清单声明范围（specifier 字段，缺失时为 ''） */
  specifier: string;
  /** 锁定版本（version 字段已剥离 `(peer@x)` 后缀，缺失时为 ''） */
  version: string;
}

/**
 * pnpm-lock.yaml importers 区块：取根 importer（键为 '.'，缺省取首个）
 * 在指定区块中的直接依赖条目；条目 meta 非普通对象时跳过。
 * version 为空的条目保留，由调用方决定是否忽略。
 */
export function readPnpmImporterEntries(
  lock: Record<string, unknown>,
  sectionKeys: readonly string[],
): PnpmImporterEntry[] {
  const entries: PnpmImporterEntry[] = [];
  const importers = lock.importers;
  if (!isRecord(importers)) return entries;
  const rootImporter = importers['.'] ?? Object.values(importers)[0];
  if (!isRecord(rootImporter)) return entries;
  for (const sectionKey of sectionKeys) {
    const section = rootImporter[sectionKey];
    if (!isRecord(section)) continue;
    for (const [name, meta] of Object.entries(section)) {
      if (!isRecord(meta)) continue;
      const specifier = typeof meta.specifier === 'string' ? meta.specifier : '';
      const version = typeof meta.version === 'string' ? meta.version.split('(')[0] : '';
      entries.push({ name, specifier, version });
    }
  }
  return entries;
}

// ────────────────────────────── yarn.lock v1 ──────────────────────────────

/** 换行符拆分（env-consistency 等跨实现复用，避免逐字重复定义） */
export const NEWLINE_RE = /\r?\n/;
/** 行首缩进检测 */
export const INDENT_RE = /^\s*/;
/** yarn 块字段行 'key value' */
const YARN_FIELD_RE = /^(\S+)\s+(.+)$/;

/** yarn 行迭代骨架：按行拆分、trim、跳过空行/注释、计算缩进。
 *  解析实现（parseYarnLock / collectYarnVersions）共用同一遍历前导，避免逐字重复。 */
export function forEachYarnLine(
  content: string,
  visit: (trimmed: string, indent: number) => void,
): void {
  for (const rawLine of content.split(NEWLINE_RE)) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = rawLine.match(INDENT_RE)?.[0].length ?? 0;
    visit(trimmed, indent);
  }
}

/** yarn.lock v1 块 */
export interface YarnBlock {
  /** 块键（可能多个，如 "lodash@^4.17.21, lodash@~4.17.0"） */
  keys: string[];
  /** 块内字段（version / resolved / integrity） */
  fields: Map<string, string>;
}

/** 剥离块头整体引号后按逗号拆分为块键（'"a@1, b@2":' → ['a@1', 'b@2']） */
export function parseYarnBlockKeys(headerLine: string): string[] {
  let keysText = headerLine.slice(0, -1).trim();
  if (keysText.length >= 2 && keysText.startsWith('"') && keysText.endsWith('"')) {
    keysText = keysText.slice(1, -1);
  }
  return keysText.split(',').map((k) => k.trim());
}

/** yarn.lock v1 字段行：`  version "4.17.21"`（键与值空白分隔） */
function collectYarnField(current: YarnBlock, trimmed: string): void {
  const m = trimmed.match(YARN_FIELD_RE);
  if (!m) return;
  let value = m[2].trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  current.fields.set(m[1], value);
}

/** 解析 yarn.lock v1 块式格式（"name@range":\n  version "x.y.z"） */
export function parseYarnLock(content: string): YarnBlock[] {
  const blocks: YarnBlock[] = [];
  let current: YarnBlock | null = null;
  forEachYarnLine(content, (trimmed, indent) => {
    if (indent === 0 && trimmed.endsWith(':')) {
      current = { keys: parseYarnBlockKeys(trimmed), fields: new Map() };
      blocks.push(current);
      return;
    }
    if (current) {
      collectYarnField(current, trimmed);
    }
  });
  return blocks;
}

// ────────────────────────────── pyproject.toml ──────────────────────────────

/** TOML 节头拆分 */
const TOML_SECTION_RE = /^\s*\[/m;
/** TOML 节标题提取 */
const TOML_HEADER_RE = /^([^\]]+)\]/;
/** TOML dependencies 数组起始 */
const TOML_DEPS_ARRAY_RE = /dependencies\s*=\s*\[/;
/** TOML 双引号字符串（matchAll） */
const TOML_QUOTED_RE = /"([^"]+)"/g;
/** 剥离 extras [...] */
const BRACKET_EXTRAS_RE = /\[.*?\]/g;
/** PEP 508 条目：包名 + 剩余约束 */
const PEP508_ENTRY_RE = /^([A-Za-z0-9_.-]+)(.*)$/;
/** poetry.toml 键行 */
const POETRY_TOML_KEY_RE = /^\s*([A-Za-z0-9_.-]+)\s*=/;

/** 从引号值中提取包名与约束（剥离 extras；如 'flask[async]>=2.0' → flask + >=2.0） */
function parsePep508(entry: string): { name: string; constraint: string } | null {
  const withoutExtras = entry.replace(BRACKET_EXTRAS_RE, '');
  const m = withoutExtras.match(PEP508_ENTRY_RE);
  if (!m) return null;
  return { name: m[1], constraint: m[2].trim() };
}

/** [project].dependencies 数组（PEP 621）：双引号包名 + 附带约束 */
function collectProjectSectionDeps(section: string, out: Map<string, string>): void {
  const depsBlock = section.match(TOML_DEPS_ARRAY_RE);
  if (!depsBlock) return;
  const block = section.slice(section.indexOf(depsBlock[0]) + depsBlock[0].length);
  for (const m of block.matchAll(TOML_QUOTED_RE)) {
    const parsed = parsePep508(m[1]);
    if (parsed) out.set(parsed.name, parsed.constraint);
  }
}

/** [tool.poetry.dependencies] / [tool.uv.dependencies]：表键即包名（python 为特殊键，非依赖） */
function collectPoetrySectionDeps(section: string, out: Map<string, string>): void {
  for (const line of section.split(NEWLINE_RE)) {
    if (line.trim().startsWith('[')) continue;
    const key = line.match(POETRY_TOML_KEY_RE);
    if (!key) continue;
    const name = key[1];
    if (name === 'python') continue;
    out.set(name, parsePoetryConstraint(line.slice(line.indexOf('=') + 1)));
  }
}

/**
 * pyproject.toml 依赖声明写入 out（name → 范围）：
 * [project] 的 dependencies 数组（PEP 621），以及
 * [tool.poetry.dependencies] / [tool.uv.dependencies] 的表键。
 */
export function collectPyprojectDependencies(content: string, out: Map<string, string>): void {
  for (const section of content.split(TOML_SECTION_RE)) {
    const header = section.match(TOML_HEADER_RE);
    if (!header) continue;
    const sectionName = header[1].trim().toLowerCase();
    if (sectionName === 'project') {
      collectProjectSectionDeps(section, out);
    } else if (
      sectionName === 'tool.poetry.dependencies' ||
      sectionName === 'tool.uv.dependencies'
    ) {
      collectPoetrySectionDeps(section, out);
    }
  }
}

// ────────────────────────────── Pipfile.lock ──────────────────────────────

/** Pipfile.lock 中的一条依赖声明 */
export interface PipfileLockEntry {
  /** 包名（_meta 区块键已跳过） */
  name: string;
  /** 声明范围（version 字段，缺失时为 ''） */
  declaredRange: string;
  /** 是否带非空 hashes 数组（完整性依据） */
  hasHashes: boolean;
}

/** Pipfile.lock 的 default / develop 区块 → 依赖声明列表 */
export function collectPipfileLockDeps(data: Record<string, unknown>): PipfileLockEntry[] {
  const deps: PipfileLockEntry[] = [];
  for (const section of ['default', 'develop'] as const) {
    const sectionData = data[section];
    if (!isRecord(sectionData)) continue;
    for (const [name, meta] of Object.entries(sectionData)) {
      if (name === '_meta') continue;
      if (!isRecord(meta)) continue;
      const declaredRange = typeof meta.version === 'string' ? meta.version : '';
      const hashes = meta.hashes;
      const hasHashes = Array.isArray(hashes) && hashes.length > 0;
      deps.push({ name, declaredRange, hasHashes });
    }
  }
  return deps;
}

// ────────────────────────────── poetry.lock ──────────────────────────────

/** poetry.lock 包块分隔 */
const POETRY_BLOCK_RE = /^\s*\[\[package\]\]\s*$/m;
/** poetry.lock name 字段 */
const POETRY_NAME_FIELD_RE = /^\s*name\s*=\s*["']([^"']+)["']/m;
/** poetry.lock version 字段 */
const POETRY_VERSION_FIELD_RE = /^\s*version\s*=\s*["']([^"']+)["']/m;
/** poetry.lock hash 存在检测 */
const POETRY_HASH_RE = /\bhash\s*=/;

/** poetry.lock 中的单个包 */
export interface PoetryLockPackage {
  /** 包名 */
  name: string;
  /** 锁定版本 */
  version: string;
  /** 是否带 [files] 哈希（完整性依据） */
  hasHashes: boolean;
}

/** 解析 poetry.lock：[[package]] 块 → name / version / 是否带 [files] 哈希 */
export function readPoetryLockPackages(content: string): PoetryLockPackage[] {
  const packages: PoetryLockPackage[] = [];
  for (const block of content.split(POETRY_BLOCK_RE)) {
    const nameMatch = block.match(POETRY_NAME_FIELD_RE);
    const versionMatch = block.match(POETRY_VERSION_FIELD_RE);
    if (!nameMatch || !versionMatch) continue;
    const idx = block.indexOf('[files]');
    const filesSection = idx >= 0 ? block.slice(idx) : '';
    const hasHashes = filesSection !== '' && POETRY_HASH_RE.test(filesSection);
    packages.push({ name: nameMatch[1], version: versionMatch[1], hasHashes });
  }
  return packages;
}

/** 匹配精确版本约束 `==` / `===` */
const EXACT_CONSTRAINT_RE = /^(?:==|===)\s*(.+)$/;

/** 剥离版本开头的非数字前缀 */
const NON_DIGIT_PREFIX_RE = /^[^0-9]*/;

/** 匹配 poetry 版本值 `version = "x.y.z"` */
const POETRY_VERSION_VALUE_RE = /version\s*=\s*["']([^"']+)["']/;

/** 从约束中提取版本号 */
export function versionFromConstraint(constraint: string): string {
  const trimmed = constraint.trim();
  const first = trimmed.split(',')[0].trim();
  const exact = first.match(EXACT_CONSTRAINT_RE);
  if (exact) return exact[1].trim();
  return first.replace(NON_DIGIT_PREFIX_RE, '').trim();
}

/** 解析 poetry 版本约束（含 `{ version = "..." }` 表与引号包裹） */
export function parsePoetryConstraint(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) {
    const m = trimmed.match(POETRY_VERSION_VALUE_RE);
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
