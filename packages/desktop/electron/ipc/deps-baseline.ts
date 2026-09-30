/**
 * 依赖哈希基线工具（ipc/deps-baseline.ts）
 *
 * 基线持久化到 <projectRoot>/.zhshield/deps-baseline.json（与 secrets-state.json 同目录约定）。
 * 引擎层（@zh/dependency lockfile-verifier）保持纯计算、只消费 expectedIntegrity；
 * 读写归桌面接线层，不把 .zhshield 路径约定带进通用引擎包。
 * 写入 tmp+rename 原子替换；读取失败降级为 null（无基线行为），绝不抛异常。
 */
import { createBaselineIo } from '@zh/shared';
import type { DependencyNode } from '@zh/dependency';

/** 依赖完整性基线（deps-baseline.json）：抓取时间 + 包名→integrity 映射 */
export interface DepsBaseline {
  version: 1;
  capturedAt: string;
  integrity: Record<string, string>;
}

const BASELINE_VERSION = 1;
const BASELINE_FILE = 'deps-baseline.json';

/** 完整性失败消息形如 [direct] lodash@4.17.21 校验和不匹配：期望 …，实际 … */
const MISMATCHED_INTEGRITY_RE = /^\[[^\]]*\] (\S+) 校验和不匹配/;

function isIntegrityMap(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null;
}

const depsBaselineIo = createBaselineIo<DepsBaseline, Record<string, string>>({
  fileName: BASELINE_FILE,
  version: BASELINE_VERSION,
  payloadKey: 'integrity',
  isPayload: isIntegrityMap,
  buildRecord: (capturedAt, integrity) => ({ version: BASELINE_VERSION, capturedAt, integrity }),
  warnTag: 'deps-baseline',
  warnOnNotFound: true,
});

export function depsBaselinePath(projectRoot: string): string {
  return depsBaselineIo.path(projectRoot);
}

/** 读取基线；文件缺失 / 版本不符 / 损坏 → null（降级为无基线行为，ENOENT 亦告警以暴露调用时序异常） */
export function loadDepsBaseline(projectRoot: string): Promise<DepsBaseline | null> {
  return depsBaselineIo.load(projectRoot);
}

/** 写入基线（tmp+rename 原子替换），返回落盘基线 */
export function saveDepsBaseline(
  projectRoot: string,
  integrityMap: Record<string, string>,
): Promise<DepsBaseline> {
  return depsBaselineIo.save(projectRoot, integrityMap);
}

/** 节点 id → integrity 快照（仅含带哈希的节点）；node.id 即 name@version，与 verifier key 一致 */
export function integritySnapshot(nodes: readonly DependencyNode[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const node of nodes) {
    if (node.integrity !== undefined) map[node.id] = node.integrity;
  }
  return map;
}

/** 从完整性失败清单提取被篡改（哈希真实改变）的节点 id */
export function extractMismatchedNodeIds(integrityFailures: readonly string[]): string[] {
  const ids: string[] = [];
  for (const message of integrityFailures) {
    const match = MISMATCHED_INTEGRITY_RE.exec(message);
    if (match) ids.push(match[1]);
  }
  return ids;
}

/** 将被篡改节点覆盖为最高危 trust（浅拷贝替换，不原地修改原数组） */
export function applyMismatchedTrust(
  nodes: readonly DependencyNode[],
  mismatchedNodeIds: readonly string[],
): DependencyNode[] {
  if (mismatchedNodeIds.length === 0) return [...nodes];
  const mismatched = new Set(mismatchedNodeIds);
  return nodes.map((node) => (mismatched.has(node.id) ? { ...node, trust: 'compromised' } : node));
}
