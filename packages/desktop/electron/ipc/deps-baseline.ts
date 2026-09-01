/**
 * 依赖哈希基线工具（ipc/deps-baseline.ts）
 *
 * 基线持久化到 <projectRoot>/.zhshield/deps-baseline.json（与 secrets-state.json 同目录约定）。
 * 引擎层（@zh/dependency lockfile-verifier）保持纯计算、只消费 expectedIntegrity；
 * 读写归桌面接线层，不把 .zhshield 路径约定带进通用引擎包。
 * 写入 tmp+rename 原子替换；读取失败降级为 null（无基线行为），绝不抛异常。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DependencyNode } from '@zh/dependency';

export interface DepsBaseline {
  version: 1;
  capturedAt: string;
  integrity: Record<string, string>;
}

const BASELINE_VERSION = 1;
const BASELINE_DIR = '.zhshield';
const BASELINE_FILE = 'deps-baseline.json';

/** 完整性失败消息形如 [direct] lodash@4.17.21 校验和不匹配：期望 …，实际 … */
const MISMATCHED_INTEGRITY_RE = /^\[[^\]]*\] (\S+) 校验和不匹配/;

export function depsBaselinePath(projectRoot: string): string {
  return join(projectRoot, BASELINE_DIR, BASELINE_FILE);
}

/** 读取基线；文件缺失 / 版本不符 / 损坏 → null（降级为无基线行为） */
export async function loadDepsBaseline(projectRoot: string): Promise<DepsBaseline | null> {
  const file = depsBaselinePath(projectRoot);
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { version, capturedAt, integrity } = parsed as Partial<DepsBaseline>;
    if (
      version !== BASELINE_VERSION ||
      typeof capturedAt !== 'string' ||
      typeof integrity !== 'object' ||
      integrity === null
    ) {
      return null;
    }
    return {
      version: BASELINE_VERSION,
      capturedAt,
      integrity: integrity as Record<string, string>,
    };
  } catch (err) {
    // 文件缺失（ENOENT）或损坏均降级为无基线，绝不抛异常
    console.warn(
      '[deps-baseline] 读取失败，降级为无基线:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** 写入基线（tmp+rename 原子替换），返回落盘基线 */
export async function saveDepsBaseline(
  projectRoot: string,
  integrityMap: Record<string, string>,
): Promise<DepsBaseline> {
  const dir = join(projectRoot, BASELINE_DIR);
  await mkdir(dir, { recursive: true });
  const baseline: DepsBaseline = {
    version: BASELINE_VERSION,
    capturedAt: new Date().toISOString(),
    integrity: integrityMap,
  };
  const file = depsBaselinePath(projectRoot);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(baseline, null, 2), 'utf-8');
  await rename(tmp, file);
  return baseline;
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
