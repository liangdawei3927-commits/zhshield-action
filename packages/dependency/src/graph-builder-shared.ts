/**
 * 依赖图谱构建器共享工具（graph-builder-shared.ts）
 *
 * 存放各生态解析模块共用的构建结果类型、节点构造工具与根边构造工具，
 * 避免 npm / Python 解析模块与 graph-builder 主模块之间横向复制代码。
 */
import type { DependencyEdge, DependencyNode, TrustStatus } from './types';
import { ROOT_NODE_ID } from './types';

/** 构建结果：节点 + 边 + 锁文件是否可解析 */
/**
 * 图谱构建上下文：各生态解析共用的「声明范围 + 节点收集目标 + 两个索引」。
 *
 * `collectYarnDirects` 与 `collectPoetryPackage` 的参数对象此前各写一遍这四项，
 * 连注释都逐字相同。各生态只需在本接口上补自己特有的入参。
 */
export interface GraphBuildContext {
  /** 清单声明（name → 版本范围） */
  readonly declared: Map<string, string>;
  /** 节点收集目标 */
  readonly nodes: DependencyNode[];
  /** 节点索引（id → node） */
  readonly byId: Map<string, DependencyNode>;
  /** 名称索引（name → node） */
  readonly byName: Map<string, DependencyNode>;
}

/**
 * 组装图谱：建三个收集容器 → 交给各生态填充 → 统一建根边并返回。
 *
 * yarn（graph-builder）与 poetry（graph-builder-python）此前各写一遍这段脚手架
 * —— 两个 `new Map`、节点数组、`buildRootEdges(declared, byName)`、
 * `return { nodes, edges, present: true }`。各生态的差异只在「怎么填节点」，
 * 那部分由 `collect` 承担。
 */
export function assembleGraph(
  declared: Map<string, string>,
  collect: (context: GraphBuildContext) => void,
): BuildResult {
  const nodes: DependencyNode[] = [];
  const byId = new Map<string, DependencyNode>();
  const byName = new Map<string, DependencyNode>();
  collect({ declared, nodes, byId, byName });
  return { nodes, edges: buildRootEdges(declared, byName), present: true };
}

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
