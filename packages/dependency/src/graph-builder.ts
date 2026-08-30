/**
 * 依赖图谱构建器（graph-builder.ts）
 *
 * 纯静态解析项目锁文件 / 清单，输出 DependencyGraph。
 * 不联网、不执行安装命令；解析失败时按缺失处理，绝不抛异常。
 *
 * 支持：
 * - npm：package-lock.json（v1 dependencies 嵌套 / v2/v3 packages 映射）
 * - pnpm：pnpm-lock.yaml v6+（importers 直接依赖 + packages 完整性）
 * - yarn：yarn.lock v1（块式键值解析）
 * - Python：requirements.txt / pyproject.toml（PEP 621 + poetry）/ Pipfile.lock / poetry.lock
 */
import * as fs from 'fs';
import * as path from 'path';
import { load as loadYaml } from 'js-yaml';
import type { DependencyEdge, DependencyGraph, DependencyNode, Ecosystem, LockfileStatus, TrustStatus } from './types';
import { ROOT_NODE_ID } from './types';
import { safeJoin } from '@zh/shared';
import { satisfiesVersion } from './adapters/lockfile-verifier';

// ────────────────────────────── 模块级正则常量（避免每次调用重编译） ──────────────────────────────
/** 换行符拆分 */
const NEWLINE_RE = /\r?\n/;
/** 行首缩进检测 */
const INDENT_RE = /^\s*/;
/** yarn块字段行 'key value' */
const YARN_FIELD_RE = /^(\S+)\s+(.+)$/;
/** 精确版本约束：'==2.3.2' / '===2.3.2' */
const EXACT_CONSTRAINT_RE = /^(?:==|===)\s*(.+)$/;
/** 非数字前缀剥离 */
const NON_DIGIT_PREFIX_RE = /^[^0-9]*/;
/** PEP 508 入口：包名 + 剩余约束 */
const PEP508_ENTRY_RE = /^([A-Za-z0-9_.-]+)(.*)$/;
/** 行注释剥离（#...） */
const COMMENT_STRIPPING_RE = /#.*/;
/** PEP 508 包名 */
const PEP508_NAME_RE = /^[A-Za-z0-9_.-]+/;
/** 版本约束操作符匹配 */
const CONSTRAINT_RE = /(?:==|>=|<=|!=|~=|===|>|<)\s*[^\s]+/;
/** poetry 约束值 version = "..." */
const POETRY_VERSION_VALUE_RE = /version\s*=\s*["']([^"']+)["']/;
/** TOML 节头拆分 */
const TOML_SECTION_RE = /^\s*\[/m;
/** TOML 节标题提取 */
const TOML_HEADER_RE = /^([^\]]+)\]/;
/** TOML dependencies 数组起始 */
const TOML_DEPS_ARRAY_RE = /dependencies\s*=\s*\[/;
/** poetry.toml 键行 */
const POETRY_TOML_KEY_RE = /^\s*([A-Za-z0-9_.-]+)\s*=/;
/** poetry.lock 包块分隔 */
const POETRY_BLOCK_RE = /^\s*\[\[package\]\]\s*$/m;
/** poetry.lock name 字段 */
const POETRY_NAME_FIELD_RE = /^\s*name\s*=\s*["']([^"']+)["']/m;
/** poetry.lock version 字段 */
const POETRY_VERSION_FIELD_RE = /^\s*version\s*=\s*["']([^"']+)["']/m;

/** 构建结果：节点 + 边 + 锁文件是否可解析 */
interface BuildResult {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  /** 锁文件是否存在且成功解析 */
  present: boolean;
}

/** package.json 中声明的直接依赖（name → 声明范围） */
interface DirectDeps {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
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
    // 无法解析时按缺失处理
    return null;
  }
}

/** 安全读取 YAML 文件；解析失败返回 null */
function readYamlSafe(filePath: string): unknown {
  try {
    return loadYaml(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    // 无法解析时按缺失处理
    return null;
  }
}

/** 安全读取文本文件；读取失败返回 null */
function readTextSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    // 无法读取时按缺失处理
    return null;
  }
}

/** 读取 package.json 的 dependencies / devDependencies 声明 */
function readPackageJson(projectPath: string): DirectDeps | null {
  const data = readJsonSafe(safeJoin(projectPath, 'package.json'));
  if (!data) return null;

  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  for (const key of ['dependencies', 'devDependencies'] as const) {
    const section = data[key];
    if (!isRecord(section)) continue;
    for (const [name, range] of Object.entries(section)) {
      if (typeof range !== 'string') continue;
      if (key === 'dependencies') dependencies[name] = range;
      else devDependencies[name] = range;
    }
  }
  return { dependencies, devDependencies };
}

/** 信任状态：有完整性哈希即视为 verified，否则 unknown */
function trustFromIntegrity(integrity: string | undefined): TrustStatus {
  return integrity ? 'verified' : 'unknown';
}

/** 依据草稿构建节点（可选字段仅在定义时写入） */
function makeNode(draft: {
  name: string;
  version: string;
  declaredRange: string;
  kind: DependencyNode['kind'];
  integrity?: string;
  trust: TrustStatus;
  deprecated?: boolean;
  license?: string;
}): DependencyNode {
  const node: DependencyNode = {
    id: `${draft.name}@${draft.version}`,
    name: draft.name,
    version: draft.version,
    declaredRange: draft.declaredRange,
    kind: draft.kind,
    trust: draft.trust,
    vulnerabilities: [],
  };
  if (draft.integrity !== undefined) node.integrity = draft.integrity;
  if (draft.deprecated === true) node.deprecated = true;
  if (draft.license !== undefined) node.license = draft.license;
  return node;
}

// ────────────────────────────── npm ──────────────────────────────

/** lockfile v2/v3 packages 键中的包名：node_modules/<包名>（含 @scope/name 形式） */
const PACKAGE_KEY_RE = /^node_modules\/(@[^/]+\/[^/]+|[^/]+)/;

/** 收集 npm v2/v3 packages 映射为节点（含 license / integrity / deprecated） */
function collectNpmPackagesMap(
  packages: Record<string, unknown>,
  pkgJson: DirectDeps | null,
): { nodes: DependencyNode[]; edges: DependencyEdge[] } {
  const byId = new Map<string, DependencyNode>();
  const firstIdByName = new Map<string, string>();
  for (const [key, meta] of Object.entries(packages)) {
    collectNpmPackageEntry(key, meta, byId, firstIdByName);
  }
  const edges = buildNpmDirectEdges(pkgJson, byId, firstIdByName);
  return { nodes: [...byId.values()], edges };
}

/** 单个 packages 条目 → 节点（含 license / integrity / deprecated） */
function collectNpmPackageEntry(
  key: string,
  meta: unknown,
  byId: Map<string, DependencyNode>,
  firstIdByName: Map<string, string>,
): void {
  const m = key.match(PACKAGE_KEY_RE);
  if (!m) return;
  if (!isRecord(meta)) return;
  const name = m[1];
  const version = typeof meta.version === 'string' ? meta.version : '';
  if (version === '') return;
  const id = `${name}@${version}`;
  if (byId.has(id)) return;
  const integrity = typeof meta.integrity === 'string' ? meta.integrity : undefined;
  const license = typeof meta.license === 'string' ? meta.license : undefined;
  const deprecated = typeof meta.deprecated === 'string' ? true : undefined;
  const node = makeNode({
    name,
    version,
    declaredRange: '',
    kind: 'transitive',
    integrity,
    trust: trustFromIntegrity(integrity),
    deprecated,
    license,
  });
  byId.set(id, node);
  if (!firstIdByName.has(name)) firstIdByName.set(name, id);
}

/** 直接依赖：以 package.json 声明为准（声明范围 + direct 标记 + 根边） */
function buildNpmDirectEdges(
  pkgJson: DirectDeps | null,
  byId: Map<string, DependencyNode>,
  firstIdByName: Map<string, string>,
): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  if (!pkgJson) return edges;
  const declared = new Map<string, string>([
    ...Object.entries(pkgJson.dependencies),
    ...Object.entries(pkgJson.devDependencies),
  ]);
  for (const [name, range] of declared) {
    const targetId = firstIdByName.get(name);
    if (!targetId) continue;
    const node = byId.get(targetId);
    if (node) {
      node.kind = 'direct';
      node.declaredRange = range;
    }
    edges.push({ from: ROOT_NODE_ID, to: targetId, requirement: range });
  }
  return edges;
}

/** 递归收集 npm v1 dependencies 嵌套结构 */
function collectNpmV1Deps(
  deps: Record<string, unknown>,
  pkgJson: DirectDeps | null,
  nodes: DependencyNode[],
  index: Map<string, DependencyNode>,
  isRootLevel: boolean,
): void {
  const declared = new Map<string, string>(
    pkgJson
      ? [...Object.entries(pkgJson.dependencies), ...Object.entries(pkgJson.devDependencies)]
      : [],
  );

  for (const [name, meta] of Object.entries(deps)) {
    if (!isRecord(meta)) continue;
    const version = typeof meta.version === 'string' ? meta.version : '';
    if (version === '') continue;
    const id = `${name}@${version}`;
    if (index.has(id)) continue;

    const isDirect = isRootLevel && declared.has(name);
    const range = isDirect ? declared.get(name) ?? '' : '';
    const integrity = typeof meta.integrity === 'string' ? meta.integrity : undefined;
    const node = makeNode({
      name,
      version,
      declaredRange: range,
      kind: isDirect ? 'direct' : 'transitive',
      integrity,
      trust: trustFromIntegrity(integrity),
    });
    nodes.push(node);
    index.set(id, node);

    const nested = meta.dependencies;
    if (isRecord(nested)) {
      collectNpmV1Deps(nested, pkgJson, nodes, index, false);
    }
  }
}

/** 解析 package-lock.json（v1 / v2 / v3） */
function buildNpmLockGraph(npmLockPath: string, pkgJson: DirectDeps | null): BuildResult {
  const lock = readJsonSafe(npmLockPath);
  if (!lock) return { nodes: [], edges: [], present: false };

  const lockfileVersion = lock.lockfileVersion;
  const isV1 =
    lockfileVersion === 1 ||
    (lockfileVersion === undefined && isRecord(lock.dependencies) && !isRecord(lock.packages));

  if (isV1) {
    const deps = lock.dependencies;
    if (!isRecord(deps)) return { nodes: [], edges: [], present: true };
    const nodes: DependencyNode[] = [];
    const index = new Map<string, DependencyNode>();
    collectNpmV1Deps(deps, pkgJson, nodes, index, true);
    const edges: DependencyEdge[] = nodes
      .filter((node) => node.kind === 'direct')
      .map((node) => ({ from: ROOT_NODE_ID, to: node.id, requirement: node.declaredRange }));
    return { nodes, edges, present: true };
  }

  const packages = lock.packages;
  if (!isRecord(packages)) return { nodes: [], edges: [], present: true };
  const { nodes, edges } = collectNpmPackagesMap(packages, pkgJson);
  return { nodes, edges, present: true };
}

// ────────────────────────────── pnpm ──────────────────────────────

/**
 * pnpm-lock.yaml packages 键（YAML 解析后无引号）：
 * - v6：/name@version 或 /@scope/name@version
 * - v9（pnpm 10/11）：name@version 或 @scope/name@version（无前导斜杠）
 * 两种格式都可能带 peer 依赖后缀 (peer@version)
 */
const PNPM_PACKAGE_KEY_RE = /^\/?(@[^/]+\/[^/]+|[^/@]+)@(.+)$/;

/** 解析 pnpm-lock.yaml v6+：importers 直接依赖 + packages 完整性哈希 */
function collectPnpm(lock: Record<string, unknown>): { nodes: DependencyNode[]; edges: DependencyEdge[] } {
  const nodes: DependencyNode[] = [];
  const byId = new Map<string, DependencyNode>();
  const edges: DependencyEdge[] = [];
  const integrityById = collectPnpmIntegrity(lock);
  collectPnpmImporters(lock, nodes, byId, edges, integrityById);
  collectPnpmTransitives(integrityById, nodes, byId);
  return { nodes, edges };
}

/** packages 区块：/name@version → integrity */
function collectPnpmIntegrity(lock: Record<string, unknown>): Map<string, string> {
  const integrityById = new Map<string, string>();
  const packages = lock.packages;
  if (!isRecord(packages)) return integrityById;
  for (const [key, meta] of Object.entries(packages)) {
    const m = key.match(PNPM_PACKAGE_KEY_RE);
    if (!m) continue;
    if (!isRecord(meta)) continue;
    const name = m[1];
    const version = m[2].split('(')[0];
    if (!version) continue;
    const id = `${name}@${version}`;
    const resolution = isRecord(meta.resolution) ? meta.resolution : undefined;
    const integrity =
      typeof resolution?.integrity === 'string'
        ? resolution.integrity
        : typeof meta.integrity === 'string'
          ? meta.integrity
          : undefined;
    if (integrity) integrityById.set(id, integrity);
  }
  return integrityById;
}

/** importers 区块：直接依赖（specifier = 声明范围，version = 锁定版本） */
function collectPnpmImporters(
  lock: Record<string, unknown>,
  nodes: DependencyNode[],
  byId: Map<string, DependencyNode>,
  edges: DependencyEdge[],
  integrityById: Map<string, string>,
): void {
  const importers = lock.importers;
  if (!isRecord(importers)) return;
  const rootImporter = importers['.'] ?? Object.values(importers)[0];
  if (!isRecord(rootImporter)) return;
  for (const sectionKey of ['dependencies', 'devDependencies'] as const) {
    const section = rootImporter[sectionKey];
    if (!isRecord(section)) continue;
    for (const [name, meta] of Object.entries(section)) {
      if (!isRecord(meta)) continue;
      const specifier = typeof meta.specifier === 'string' ? meta.specifier : '';
      const version = typeof meta.version === 'string' ? meta.version.split('(')[0] : '';
      if (!version) continue;
      const id = `${name}@${version}`;
      if (byId.has(id)) continue;
      const integrity = integrityById.get(id);
      const node = makeNode({
        name,
        version,
        declaredRange: specifier,
        kind: 'direct',
        integrity,
        trust: trustFromIntegrity(integrity),
      });
      nodes.push(node);
      byId.set(id, node);
      edges.push({ from: ROOT_NODE_ID, to: id, requirement: specifier });
    }
  }
}

/** 其余 packages 为传递依赖 */
function collectPnpmTransitives(integrityById: Map<string, string>, nodes: DependencyNode[], byId: Map<string, DependencyNode>): void {
  for (const [id, integrity] of integrityById) {
    if (byId.has(id)) continue;
    const at = id.lastIndexOf('@');
    const name = id.slice(0, at);
    const version = id.slice(at + 1);
    const node = makeNode({
      name,
      version,
      declaredRange: '',
      kind: 'transitive',
      integrity,
      trust: trustFromIntegrity(integrity),
    });
    nodes.push(node);
    byId.set(id, node);
  }
}

/** 解析 pnpm-lock.yaml */
function buildPnpmGraph(pnpmLockPath: string): BuildResult {
  const data = readYamlSafe(pnpmLockPath);
  if (!isRecord(data)) return { nodes: [], edges: [], present: false };
  const { nodes, edges } = collectPnpm(data);
  return { nodes, edges, present: true };
}

// ────────────────────────────── yarn ──────────────────────────────

/** yarn.lock v1 块 */
interface YarnBlock {
  /** 块键（可能多个，如 "lodash@^4.17.21, lodash@~4.17.0"） */
  keys: string[];
  /** 块内字段（version / resolved / integrity） */
  fields: Map<string, string>;
}

/** yarn 块键解析：name@range → { name, range }（支持 @scope/name@range） */
const YARN_KEY_RE = /^(@[^/]+\/)?([^@]+)@(.*)$/;

function parseYarnKey(key: string): { name: string; range: string } | null {
  const m = key.trim().match(YARN_KEY_RE);
  if (!m) return null;
  const scope = m[1] ?? '';
  return { name: `${scope}${m[2]}`, range: m[3] ?? '' };
}

/** 解析 yarn.lock v1 块式格式（"name@range":\n  version "x.y.z"） */
function parseYarnLock(content: string): YarnBlock[] {
  const blocks: YarnBlock[] = [];
  let current: YarnBlock | null = null;
  for (const rawLine of content.split(NEWLINE_RE)) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = rawLine.match(INDENT_RE)?.[0].length ?? 0;
    if (indent === 0 && trimmed.endsWith(':')) {
      current = startYarnBlock(trimmed, blocks);
      continue;
    }
    if (current) {
      collectYarnField(current, trimmed);
    }
  }
  return blocks;
}

/** 块头：剥离整体引号后再按逗号拆分键 */
function startYarnBlock(trimmed: string, blocks: YarnBlock[]): YarnBlock {
  let keysText = trimmed.slice(0, -1).trim();
  if (keysText.length >= 2 && keysText.startsWith('"') && keysText.endsWith('"')) {
    keysText = keysText.slice(1, -1);
  }
  const block: YarnBlock = { keys: keysText.split(',').map((k) => k.trim()), fields: new Map() };
  blocks.push(block);
  return block;
}

/** yarn.lock v1 字段行无冒号：`  version "4.17.21"`（键与值空白分隔） */
function collectYarnField(current: YarnBlock, trimmed: string): void {
  const m = trimmed.match(YARN_FIELD_RE);
  if (!m) return;
  let value = m[2].trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  current.fields.set(m[1], value);
}

/** 解析 yarn.lock v1：直接依赖来自 package.json，锁定版本来自块 */
function buildYarnGraph(yarnLockPath: string, pkgJson: DirectDeps | null): BuildResult {
  const content = readTextSafe(yarnLockPath);
  if (content === null) return { nodes: [], edges: [], present: false };
  const blocks = parseYarnLock(content);
  const declared = new Map<string, string>([
    ...(pkgJson ? Object.entries(pkgJson.dependencies) : []),
    ...(pkgJson ? Object.entries(pkgJson.devDependencies) : []),
  ]);
  const nodes: DependencyNode[] = [];
  const byId = new Map<string, DependencyNode>();
  const byName = new Map<string, DependencyNode>();
  collectYarnDirects(blocks, declared, nodes, byId, byName);
  collectYarnTransitives(blocks, nodes, byId);
  const edges = buildRootEdges(declared, byName);
  return { nodes, edges, present: true };
}

/** 第一遍：直接依赖（声明范围精确匹配块键） */
function collectYarnDirects(
  blocks: YarnBlock[],
  declared: Map<string, string>,
  nodes: DependencyNode[],
  byId: Map<string, DependencyNode>,
  byName: Map<string, DependencyNode>,
): void {
  for (const block of blocks) {
    const version = block.fields.get('version');
    if (!version) continue;
    let resolved: { name: string; range: string } | null = null;
    for (const key of block.keys) {
      const parsed = parseYarnKey(key);
      if (parsed && declared.has(parsed.name) && declared.get(parsed.name) === parsed.range) {
        resolved = { name: parsed.name, range: parsed.range };
        break;
      }
    }
    if (!resolved) continue;
    const id = `${resolved.name}@${version}`;
    if (byId.has(id)) continue;
    const integrity = block.fields.get('integrity');
    const node = makeNode({
      name: resolved.name,
      version,
      declaredRange: resolved.range,
      kind: 'direct',
      integrity,
      trust: trustFromIntegrity(integrity),
    });
    nodes.push(node);
    byId.set(id, node);
    if (!byName.has(resolved.name)) byName.set(resolved.name, node);
  }
}

/** 第二遍：其余块为传递依赖 */
function collectYarnTransitives(blocks: YarnBlock[], nodes: DependencyNode[], byId: Map<string, DependencyNode>): void {
  for (const block of blocks) {
    const version = block.fields.get('version');
    if (!version) continue;
    const firstKey = parseYarnKey(block.keys[0] ?? '');
    if (!firstKey) continue;
    const id = `${firstKey.name}@${version}`;
    if (byId.has(id)) continue;
    const integrity = block.fields.get('integrity');
    const node = makeNode({
      name: firstKey.name,
      version,
      declaredRange: '',
      kind: 'transitive',
      integrity,
      trust: trustFromIntegrity(integrity),
    });
    nodes.push(node);
    byId.set(id, node);
  }
}

/** 边：根 → 直接依赖 */
function buildRootEdges(declared: Map<string, string>, byName: Map<string, DependencyNode>): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  for (const [name, range] of declared) {
    const node = byName.get(name);
    if (node) edges.push({ from: ROOT_NODE_ID, to: node.id, requirement: range });
  }
  return edges;
}

// ────────────────────────────── Python ──────────────────────────────

/** 从版本约束提取锁定版本：'==2.3.2' → '2.3.2'；'>=2.0' → '2.0'；'*' / '' → '' */
function versionFromConstraint(constraint: string): string {
  const trimmed = constraint.trim();
  const first = trimmed.split(',')[0].trim();
  const exact = first.match(EXACT_CONSTRAINT_RE);
  if (exact) return exact[1].trim();
  return first.replace(NON_DIGIT_PREFIX_RE, '').trim();
}

/** 从引号值中提取包名与约束（剥离 extras；如 'flask[async]>=2.0' → flask + >=2.0） */
function parsePep508(entry: string): { name: string; constraint: string } | null {
  const withoutExtras = entry.replace(/\[.*?\]/g, '');
  const m = withoutExtras.match(PEP508_ENTRY_RE);
  if (!m) return null;
  return { name: m[1], constraint: m[2].trim() };
}

/** requirements.txt：逐行剥离 # 注释、环境标记、extras，跳过空行与 - 开头的选项行 */
function parseRequirements(content: string): Array<{ name: string; constraint: string }> {
  const deps: Array<{ name: string; constraint: string }> = [];
  for (const rawLine of content.split(NEWLINE_RE)) {
    let line = rawLine.replace(COMMENT_STRIPPING_RE, '').trim();
    if (line === '' || line.startsWith('-')) continue;
    line = line.split(';')[0].trim();
    line = line.replace(/\[.*?\]/g, '');
    const m = line.match(PEP508_NAME_RE);
    if (!m) continue;
    const name = m[0];
    const rest = line.slice(name.length).trim();
    const constraint = rest.match(CONSTRAINT_RE)?.[0] ?? '';
    deps.push({ name, constraint });
  }
  return deps;
}

/** poetry 依赖约束值解析：'^2.0' / '"*"' / '{ version = "^2.0", ... }' → 版本约束字符串 */
function parsePoetryConstraint(value: string): string {
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

/**
 * pyproject.toml：按节拆分，仅处理目标区块——
 * [project] 的 dependencies 数组（PEP 621，双引号包名，附带版本约束）；
 * [tool.poetry.dependencies] / [tool.uv.dependencies] 的表键即包名。
 */
function parsePyproject(content: string): { dependencies: Map<string, string>; devDependencies: Map<string, string> } {
  const dependencies = new Map<string, string>();
  const devDependencies = new Map<string, string>();
  const sections = content.split(TOML_SECTION_RE);

  for (const section of sections) {
    const header = section.match(TOML_HEADER_RE);
    if (!header) continue;
    const sectionName = header[1].trim().toLowerCase();

    if (sectionName === 'project') {
      collectProjectDeps(section, dependencies);
    } else if (sectionName === 'tool.poetry.dependencies' || sectionName === 'tool.uv.dependencies') {
      collectPoetryDeps(section, dependencies);
    }
  }

  return { dependencies, devDependencies };
}

/** [project].dependencies 数组（PEP 621）：双引号包名 + 附带约束 */
function collectProjectDeps(section: string, dependencies: Map<string, string>): void {
  const depsBlock = section.match(TOML_DEPS_ARRAY_RE);
  if (!depsBlock) return;
  const block = section.slice(section.indexOf(depsBlock[0]) + depsBlock[0].length);
  for (const m of block.matchAll(/"([^"]+)"/g)) {
    const parsed = parsePep508(m[1]);
    if (parsed) dependencies.set(parsed.name, parsed.constraint);
  }
}

/** [tool.poetry.dependencies] / [tool.uv.dependencies]：表键即包名 */
function collectPoetryDeps(section: string, dependencies: Map<string, string>): void {
  for (const line of section.split(NEWLINE_RE)) {
    if (line.trim().startsWith('[')) continue;
    const key = line.match(POETRY_TOML_KEY_RE);
    if (!key) continue;
    const name = key[1];
    if (name === 'python') continue; // poetry 特殊键，非依赖
    const value = line.slice(line.indexOf('=') + 1);
    dependencies.set(name, parsePoetryConstraint(value));
  }
}

/** Pipfile.lock JSON：default / develop 两个区块的键即包名，version 字段为声明范围 */
function parsePipfileLock(content: string): Array<{ name: string; declaredRange: string }> {
  const deps: Array<{ name: string; declaredRange: string }> = [];
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    // 无法解析时按缺失处理
    return deps;
  }
  if (!isRecord(data)) return deps;

  for (const section of ['default', 'develop'] as const) {
    const sectionData = data[section];
    if (!isRecord(sectionData)) continue;
    for (const [name, meta] of Object.entries(sectionData)) {
      if (name === '_meta') continue;
      if (!isRecord(meta)) continue;
      const declaredRange = typeof meta.version === 'string' ? meta.version : '';
      deps.push({ name, declaredRange });
    }
  }
  return deps;
}

/** poetry.lock：[[package]] 块的 name / version 字段 */
function parsePoetryLock(content: string): Array<{ name: string; version: string }> {
  const packages: Array<{ name: string; version: string }> = [];
  const blocks = content.split(POETRY_BLOCK_RE);
  for (const block of blocks) {
    const nameMatch = block.match(POETRY_NAME_FIELD_RE);
    const versionMatch = block.match(POETRY_VERSION_FIELD_RE);
    if (nameMatch && versionMatch) {
      packages.push({ name: nameMatch[1], version: versionMatch[1] });
    }
  }
  return packages;
}

/** poetry.lock 图谱：pyproject.toml 提供声明与范围，poetry.lock 提供锁定版本 */
function buildPoetryGraph(poetryLockPath: string, projectPath: string): BuildResult {
  const content = readTextSafe(poetryLockPath);
  if (content === null) return { nodes: [], edges: [], present: false };
  const packages = parsePoetryLock(content);
  const declared = readPoetryDeclared(projectPath);
  const nodes: DependencyNode[] = [];
  const byId = new Map<string, DependencyNode>();
  const byName = new Map<string, DependencyNode>();
  for (const pkg of packages) {
    collectPoetryPackage(pkg, declared, nodes, byId, byName);
  }
  const edges = buildRootEdges(declared, byName);
  return { nodes, edges, present: true };
}

/** 读取 pyproject.toml 声明（dependencies + devDependencies） */
function readPoetryDeclared(projectPath: string): Map<string, string> {
  const pyprojectContent = readTextSafe(safeJoin(projectPath, 'pyproject.toml'));
  if (pyprojectContent === null) return new Map<string, string>();
  const parsed = parsePyproject(pyprojectContent);
  return new Map<string, string>([...parsed.dependencies, ...parsed.devDependencies]);
}

/** 单个 poetry.lock 包 → 节点（直接依赖标记 + 根边） */
function collectPoetryPackage(
  pkg: { name: string; version: string },
  declared: Map<string, string>,
  nodes: DependencyNode[],
  byId: Map<string, DependencyNode>,
  byName: Map<string, DependencyNode>,
): void {
  const isDirect = declared.has(pkg.name);
  const range = declared.get(pkg.name) ?? '';
  const id = `${pkg.name}@${pkg.version}`;
  if (byId.has(id)) return;
  const node = makeNode({
    name: pkg.name,
    version: pkg.version,
    declaredRange: range,
    kind: isDirect ? 'direct' : 'transitive',
    trust: 'unknown',
  });
  nodes.push(node);
  byId.set(id, node);
  if (isDirect && !byName.has(pkg.name)) byName.set(pkg.name, node);
}

/** Pipfile.lock 图谱：全部为直接依赖（锁定版本来自 version 字段） */
function buildPipfileGraph(pipfilePath: string): BuildResult {
  const content = readTextSafe(pipfilePath);
  if (content === null) return { nodes: [], edges: [], present: false };
  const packages = parsePipfileLock(content);

  const nodes: DependencyNode[] = [];
  const byId = new Map<string, DependencyNode>();
  const edges: DependencyEdge[] = [];

  for (const pkg of packages) {
    const version = versionFromConstraint(pkg.declaredRange);
    const id = `${pkg.name}@${version}`;
    if (byId.has(id)) continue;
    const node = makeNode({
      name: pkg.name,
      version,
      declaredRange: pkg.declaredRange,
      kind: 'direct',
      trust: 'unknown',
    });
    nodes.push(node);
    byId.set(id, node);
    edges.push({ from: ROOT_NODE_ID, to: id, requirement: pkg.declaredRange });
  }

  return { nodes, edges, present: true };
}

/** pyproject.toml（无锁文件）图谱：全部为直接依赖 */
function buildPyprojectGraph(pyprojectPath: string): BuildResult {
  const content = readTextSafe(pyprojectPath);
  if (content === null) return { nodes: [], edges: [], present: false };
  const parsed = parsePyproject(content);
  const declared = new Map<string, string>([...parsed.dependencies, ...parsed.devDependencies]);

  const nodes: DependencyNode[] = [];
  const byId = new Map<string, DependencyNode>();
  const edges: DependencyEdge[] = [];

  for (const [name, constraint] of declared) {
    const version = versionFromConstraint(constraint);
    const id = `${name}@${version}`;
    if (byId.has(id)) continue;
    const node = makeNode({ name, version, declaredRange: constraint, kind: 'direct', trust: 'unknown' });
    nodes.push(node);
    byId.set(id, node);
    edges.push({ from: ROOT_NODE_ID, to: id, requirement: constraint });
  }

  return { nodes, edges, present: false };
}

/** requirements.txt 图谱：全部为直接依赖 */
function buildRequirementsGraph(requirementsPath: string): BuildResult {
  const content = readTextSafe(requirementsPath);
  if (content === null) return { nodes: [], edges: [], present: false };
  const packages = parseRequirements(content);

  const nodes: DependencyNode[] = [];
  const byId = new Map<string, DependencyNode>();
  const edges: DependencyEdge[] = [];

  for (const pkg of packages) {
    const version = versionFromConstraint(pkg.constraint);
    const id = `${pkg.name}@${version}`;
    if (byId.has(id)) continue;
    const node = makeNode({
      name: pkg.name,
      version,
      declaredRange: pkg.constraint,
      kind: 'direct',
      trust: 'unknown',
    });
    nodes.push(node);
    byId.set(id, node);
    edges.push({ from: ROOT_NODE_ID, to: id, requirement: pkg.constraint });
  }

  return { nodes, edges, present: false };
}

/**
 * 构建项目依赖图谱。
 *
 * 探测优先级：npm（pnpm-lock.yaml → package-lock.json → yarn.lock）
 * → pip（poetry.lock → Pipfile.lock → pyproject.toml → requirements.txt）。
 * 清单解析失败时按缺失处理：返回空图谱且 lockfile.present=false，绝不抛异常。
 */
export function buildDependencyGraph(projectPath: string, options?: { targetId?: string }): DependencyGraph {
  const targetId = options?.targetId ?? path.basename(projectPath);
  const generatedAt = new Date().toISOString();
  const pkgJson = readPackageJson(projectPath);
  const { result, ecosystem, lockfilePath } = detectLockfileSource(projectPath, pkgJson);
  if (!result) {
    const emptyLockfile: LockfileStatus = { present: false, consistent: false, integrityVerified: false };
    return { schemaVersion: 1, targetId, ecosystem, nodes: [], edges: [], lockfile: emptyLockfile, generatedAt };
  }
  const lockfile = buildLockfileStatus(result, lockfilePath);
  return { schemaVersion: 1, targetId, ecosystem, nodes: result.nodes, edges: result.edges, lockfile, generatedAt };
}

/** 探测锁文件来源并构建图谱（优先级：pnpm → npm → yarn → poetry → Pipfile → pyproject → requirements） */
function detectLockfileSource(
  projectPath: string,
  pkgJson: DirectDeps | null,
): { result: BuildResult | null; ecosystem: Ecosystem; lockfilePath: string | null } {
  const pnpmLockPath = safeJoin(projectPath, 'pnpm-lock.yaml');
  const npmLockPath = safeJoin(projectPath, 'package-lock.json');
  const yarnLockPath = safeJoin(projectPath, 'yarn.lock');
  const poetryLockPath = safeJoin(projectPath, 'poetry.lock');
  const pipfileLockPath = safeJoin(projectPath, 'Pipfile.lock');
  const pyprojectPath = safeJoin(projectPath, 'pyproject.toml');
  const requirementsPath = safeJoin(projectPath, 'requirements.txt');

  if (fs.existsSync(pnpmLockPath)) {
    return { result: buildPnpmGraph(pnpmLockPath), ecosystem: 'npm', lockfilePath: pnpmLockPath };
  }
  if (fs.existsSync(npmLockPath)) {
    return { result: buildNpmLockGraph(npmLockPath, pkgJson), ecosystem: 'npm', lockfilePath: npmLockPath };
  }
  if (fs.existsSync(yarnLockPath)) {
    return { result: buildYarnGraph(yarnLockPath, pkgJson), ecosystem: 'npm', lockfilePath: yarnLockPath };
  }
  if (fs.existsSync(poetryLockPath)) {
    return { result: buildPoetryGraph(poetryLockPath, projectPath), ecosystem: 'pip', lockfilePath: poetryLockPath };
  }
  if (fs.existsSync(pipfileLockPath)) {
    return { result: buildPipfileGraph(pipfileLockPath), ecosystem: 'pip', lockfilePath: pipfileLockPath };
  }
  if (fs.existsSync(pyprojectPath)) {
    return { result: buildPyprojectGraph(pyprojectPath), ecosystem: 'pip', lockfilePath: null };
  }
  if (fs.existsSync(requirementsPath)) {
    return { result: buildRequirementsGraph(requirementsPath), ecosystem: 'pip', lockfilePath: null };
  }
  return { result: null, ecosystem: pkgJson ? 'npm' : 'mixed', lockfilePath: null };
}

/** 组装 LockfileStatus：完整性 / 一致性 / lastModified */
function buildLockfileStatus(result: BuildResult, lockfilePath: string | null): LockfileStatus {
  const integrityVerified =
    result.nodes.length > 0 && result.nodes.every((node) => node.integrity !== undefined);
  const consistent =
    result.present &&
    result.nodes.filter((node) => node.kind === 'direct').every((node) => satisfiesVersion(node.version, node.declaredRange));
  let lastModified: string | undefined;
  if (result.present && lockfilePath) {
    try {
      lastModified = fs.statSync(lockfilePath).mtime.toISOString();
    } catch {
      // 无法 stat 时省略 lastModified
    }
  }
  return {
    present: result.present,
    consistent,
    integrityVerified,
    ...(lastModified !== undefined ? { lastModified } : {}),
  };
}
