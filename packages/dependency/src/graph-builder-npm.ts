/**
 * npm 锁文件解析（graph-builder-npm.ts）
 *
 * 解析 package-lock.json（v1 dependencies 嵌套 / v2/v3 packages 映射），
 * 输出节点与根边；由 graph-builder.ts 统一调度。
 */
import { isRecord, readJsonSafe } from './lockfile-utils';
import type { DependencyEdge, DependencyNode } from './types';
import { ROOT_NODE_ID } from './types';
import type { BuildResult, DirectDeps } from './graph-builder-shared';
import { makeNode, trustFromIntegrity } from './graph-builder-shared';

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

/** collectNpmV1Deps 参数对象 */
interface CollectNpmV1DepsParams {
  /** npm v1 dependencies 嵌套结构 */
  readonly deps: Record<string, unknown>;
  /** package.json 直接依赖声明（可能缺失） */
  readonly pkgJson: DirectDeps | null;
  /** 节点收集目标 */
  readonly nodes: DependencyNode[];
  /** 节点索引（id → node） */
  readonly index: Map<string, DependencyNode>;
  /** 是否为根层级 */
  readonly isRootLevel: boolean;
}

/** 递归收集 npm v1 dependencies 嵌套结构 */
function collectNpmV1Deps(params: CollectNpmV1DepsParams): void {
  const { deps, pkgJson, nodes, index, isRootLevel } = params;
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
    const range = isDirect ? (declared.get(name) ?? '') : '';
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
      collectNpmV1Deps({ deps: nested, pkgJson, nodes, index, isRootLevel: false });
    }
  }
}

/** 解析 package-lock.json（v1 / v2 / v3） */
export function buildNpmLockGraph(npmLockPath: string, pkgJson: DirectDeps | null): BuildResult {
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
    collectNpmV1Deps({ deps, pkgJson, nodes, index, isRootLevel: true });
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
