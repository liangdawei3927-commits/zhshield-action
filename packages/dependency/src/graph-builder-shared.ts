/**
 * 依赖图谱构建器共享工具（graph-builder-shared.ts）
 *
 * 存放各生态解析模块共用的构建结果类型、节点构造工具与根边构造工具，
 * 避免 npm / Python 解析模块与 graph-builder 主模块之间横向复制代码。
 */
import type { DependencyEdge, DependencyNode, TrustStatus } from './types';
import { ROOT_NODE_ID } from './types';

/** 构建结果：节点 + 边 + 锁文件是否可解析 */
export interface BuildResult {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  /** 锁文件是否存在且成功解析 */
  present: boolean;
}

/** package.json 中声明的直接依赖（name → 声明范围） */
export interface DirectDeps {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

/** 信任状态：有完整性哈希即视为 verified，否则 unknown */
export function trustFromIntegrity(integrity: string | undefined): TrustStatus {
  return integrity ? 'verified' : 'unknown';
}

/** 依据草稿构建节点（可选字段仅在定义时写入） */
export function makeNode(draft: {
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

/** 边：根 → 直接依赖 */
export function buildRootEdges(
  declared: Map<string, string>,
  byName: Map<string, DependencyNode>,
): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  for (const [name, range] of declared) {
    const node = byName.get(name);
    if (node) edges.push({ from: ROOT_NODE_ID, to: node.id, requirement: range });
  }
  return edges;
}
