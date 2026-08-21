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
   * 计算内容的 SHA-256 哈希
   */
  computeContentHash(content: unknown): string {
    const data = JSON.stringify(content, Object.keys(content as Record<string, unknown>).sort());
    return createHash('sha256').update(data).digest('hex');
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

    const merged = { ...local as Record<string, unknown> };
    const remoteObj = remote as Record<string, unknown>;

    for (const [key, value] of Object.entries(remoteObj)) {
      if (!(key in merged)) {
        merged[key] = value;
      }
    }

    return merged;
  }
}
