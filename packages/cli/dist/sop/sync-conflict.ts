import { createHash } from 'node:crypto';

export enum ConflictResolution {
  LOCAL_WINS = 'local-wins',
  REMOTE_WINS = 'remote-wins',
  MERGE = 'merge',
  MANUAL = 'manual',
}

export interface SyncConflict {
  ruleId: string;
  localVersion: number;
  remoteVersion: number;
  localHash: string;
  remoteHash: string;
  localContent: unknown;
  remoteContent: unknown;
  detectedAt: Date;
}

export class SyncConflictResolver {
  /**
   * 计算内容的 SHA-256 哈希（深度稳定序列化：递归排序对象键，哈希只反映内容不反映键序）
   */
  computeContentHash(content: unknown): string {
    return createHash('sha256').update(stableStringify(content)).digest('hex');
  }

  /**
   * 检测冲突
   */
  detectConflict(
    ruleId: string,
    localVersion: number,
    remoteVersion: number,
    localContent: unknown,
    remoteContent: unknown,
  ): SyncConflict | null {
    const localHash = this.computeContentHash(localContent);
    const remoteHash = this.computeContentHash(remoteContent);

    if (localHash === remoteHash) return null;

    return {
      ruleId,
      localVersion,
      remoteVersion,
      localHash,
      remoteHash,
      localContent,
      remoteContent,
      detectedAt: new Date(),
    };
  }

  /**
   * 自动解决冲突
   */
  resolve(conflict: SyncConflict, strategy: ConflictResolution): unknown {
    switch (strategy) {
      case ConflictResolution.LOCAL_WINS:
        return conflict.localContent;
      case ConflictResolution.REMOTE_WINS:
        return conflict.remoteContent;
      case ConflictResolution.MERGE:
        return this.mergeContent(conflict.localContent, conflict.remoteContent);
      case ConflictResolution.MANUAL:
        throw new Error(`Conflict for rule ${conflict.ruleId} requires manual resolution`);
    }
  }

  /**
   * 智能合并：远程新增字段优先，本地修改的字段保留
   */
  private mergeContent(local: unknown, remote: unknown): unknown {
    if (typeof local !== 'object' || typeof remote !== 'object' || !local || !remote) {
      return remote;
    }

    const merged = { ...(local as Record<string, unknown>) };
    const remoteObj = remote as Record<string, unknown>;

    for (const [key, value] of Object.entries(remoteObj)) {
      if (!(key in merged)) {
        merged[key] = value;
      }
    }

    return merged;
  }
}

/** 深度稳定序列化：对象键递归排序（数组保序），undefined/函数折叠为 null */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
