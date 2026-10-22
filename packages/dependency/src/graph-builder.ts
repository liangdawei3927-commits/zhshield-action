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
import {
  isRecord,
  readJsonSafe,
  readYamlSafe,
  readTextSafe,
  parseYarnLock,
  readPnpmImporterEntries,
  type YarnBlock,
} from './lockfile-utils';
import type {
  DependencyEdge,
  DependencyGraph,
  DependencyNode,
  Ecosystem,
  LockfileStatus,
} from './types';
import { ROOT_NODE_ID } from './types';
import { safeJoin } from '@zh/shared';
import { satisfiesVersion } from './adapters/lockfile-verifier';
import type { BuildResult, DirectDeps } from './graph-builder-shared';
import { buildRootEdges, makeNode, trustFromIntegrity } from './graph-builder-shared';
import { buildNpmLockGraph } from './graph-builder-npm';
import {
  buildPipfileGraph,
  buildPoetryGraph,
  buildPyprojectGraph,
  buildRequirementsGraph,
} from './graph-builder-python';

/** 判断值是否为普通对象（非 null、非数组） */
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

// ────────────────────────────── pnpm ──────────────────────────────

/**
 * pnpm-lock.yaml packages 键（YAML 解析后无引号）：
 * - v6：/name@version 或 /@scope/name@version
 * - v9（pnpm 10/11）：name@version 或 @scope/name@version（无前导斜杠）
 * 两种格式都可能带 peer 依赖后缀 (peer@version)
 */
const PNPM_PACKAGE_KEY_RE = /^\/?(@[^/]+\/[^/]+|[^/@]+)@(.+)$/;

/** 解析 pnpm-lock.yaml v6+：importers 直接依赖 + packages 完整性哈希 */
function collectPnpm(lock: Record<string, unknown>): {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
} {
  const nodes: DependencyNode[] = [];
  const byId = new Map<string, DependencyNode>();
  const edges: DependencyEdge[] = [];
  const integrityById = collectPnpmIntegrity(lock);
  collectPnpmImporters({ lock, nodes, byId, edges, integrityById });
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

/** collectPnpmImporters 参数对象 */
interface CollectPnpmImportersParams {
  /** pnpm-lock.yaml 解析结果 */
  readonly lock: Record<string, unknown>;
  /** 节点收集目标 */
  readonly nodes: DependencyNode[];
  /** 节点索引（id → node） */
  readonly byId: Map<string, DependencyNode>;
  /** 边收集目标 */
  readonly edges: DependencyEdge[];
  /** 完整性哈希索引（id → integrity） */
  readonly integrityById: Map<string, string>;
}

/** importers 区块：直接依赖（specifier = 声明范围，version = 锁定版本） */
function collectPnpmImporters(params: CollectPnpmImportersParams): void {
  const { lock, nodes, byId, edges, integrityById } = params;
  for (const entry of readPnpmImporterEntries(lock, ['dependencies', 'devDependencies'])) {
    const { name, specifier, version } = entry;
    if (version === '') continue;
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

/** 其余 packages 为传递依赖 */
function collectPnpmTransitives(
  integrityById: Map<string, string>,
  nodes: DependencyNode[],
  byId: Map<string, DependencyNode>,
): void {
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

/** yarn 块键解析：name@range → { name, range }（支持 @scope/name@range） */
const YARN_KEY_RE = /^(@[^/]+\/)?([^@]+)@(.*)$/;

function parseYarnKey(key: string): { name: string; range: string } | null {
  const m = key.trim().match(YARN_KEY_RE);
  if (!m) return null;
  const scope = m[1] ?? '';
  return { name: `${scope}${m[2]}`, range: m[3] ?? '' };
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
  collectYarnDirects({ blocks, declared, nodes, byId, byName });
  collectYarnTransitives(blocks, nodes, byId);
  const edges = buildRootEdges(declared, byName);
  return { nodes, edges, present: true };
}

/** collectYarnDirects 参数对象 */
interface CollectYarnDirectsParams {
  /** yarn.lock v1 块列表 */
  readonly blocks: YarnBlock[];
  /** package.json 声明（name → 范围） */
  readonly declared: Map<string, string>;
  /** 节点收集目标 */
  readonly nodes: DependencyNode[];
  /** 节点索引（id → node） */
  readonly byId: Map<string, DependencyNode>;
  /** 名称索引（name → node） */
  readonly byName: Map<string, DependencyNode>;
}

/** 第一遍：直接依赖（声明范围精确匹配块键） */
function collectYarnDirects(params: CollectYarnDirectsParams): void {
  const { blocks, declared, nodes, byId, byName } = params;
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
function collectYarnTransitives(
  blocks: YarnBlock[],
  nodes: DependencyNode[],
  byId: Map<string, DependencyNode>,
): void {
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

/**
 * 构建项目依赖图谱。
 *
 * 探测优先级：npm（pnpm-lock.yaml → package-lock.json → yarn.lock）
 * → pip（poetry.lock → Pipfile.lock → pyproject.toml → requirements.txt）。
 * 清单解析失败时按缺失处理：返回空图谱且 lockfile.present=false，绝不抛异常。
 */
export function buildDependencyGraph(
  projectPath: string,
  options?: { targetId?: string },
): DependencyGraph {
  const targetId = options?.targetId ?? path.basename(projectPath);
  const generatedAt = new Date().toISOString();
  const pkgJson = readPackageJson(projectPath);
  const { result, ecosystem, lockfilePath } = detectLockfileSource(projectPath, pkgJson);
  if (!result) {
    const emptyLockfile: LockfileStatus = {
      present: false,
      consistent: false,
      integrityVerified: false,
    };
    return {
      schemaVersion: 1,
      targetId,
      ecosystem,
      nodes: [],
      edges: [],
      lockfile: emptyLockfile,
      generatedAt,
    };
  }
  const lockfile = buildLockfileStatus(result, lockfilePath);
  return {
    schemaVersion: 1,
    targetId,
    ecosystem,
    nodes: result.nodes,
    edges: result.edges,
    lockfile,
    generatedAt,
  };
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
    return {
      result: buildNpmLockGraph(npmLockPath, pkgJson),
      ecosystem: 'npm',
      lockfilePath: npmLockPath,
    };
  }
  if (fs.existsSync(yarnLockPath)) {
    return {
      result: buildYarnGraph(yarnLockPath, pkgJson),
      ecosystem: 'npm',
      lockfilePath: yarnLockPath,
    };
  }
  if (fs.existsSync(poetryLockPath)) {
    return {
      result: buildPoetryGraph(poetryLockPath, projectPath),
      ecosystem: 'pip',
      lockfilePath: poetryLockPath,
    };
  }
  if (fs.existsSync(pipfileLockPath)) {
    return {
      result: buildPipfileGraph(pipfileLockPath),
      ecosystem: 'pip',
      lockfilePath: pipfileLockPath,
    };
  }
  if (fs.existsSync(pyprojectPath)) {
    return { result: buildPyprojectGraph(pyprojectPath), ecosystem: 'pip', lockfilePath: null };
  }
  if (fs.existsSync(requirementsPath)) {
    return {
      result: buildRequirementsGraph(requirementsPath),
      ecosystem: 'pip',
      lockfilePath: null,
    };
  }
  return { result: null, ecosystem: pkgJson ? 'npm' : 'mixed', lockfilePath: null };
}

/** 组装 LockfileStatus：完整性 / 一致性 / lastModified */
function buildLockfileStatus(result: BuildResult, lockfilePath: string | null): LockfileStatus {
  const integrityVerified =
    result.nodes.length > 0 && result.nodes.every((node) => node.integrity !== undefined);
  const consistent =
    result.present &&
    result.nodes
      .filter((node) => node.kind === 'direct')
      .every((node) => satisfiesVersion(node.version, node.declaredRange));
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
