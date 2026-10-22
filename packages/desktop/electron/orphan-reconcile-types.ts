// ─── 类型 ───

/** 孤儿判定原因：目录缺失 / 目录为空 / 目录存在但仍有活跃数据 */
export type OrphanReason = 'dir_missing' | 'dir_empty' | 'dir_present_with_content';

/** 孤儿项目核对报告：确认/疑似孤儿清单、已回收画像与已清理的表行数 */
export interface OrphanReconcileReport {
  scannedAt: string;
  activeProjectPaths: string[];
  confirmedOrphans: Array<{
    projectId: string;
    reason: OrphanReason;
    activeRowCounts: { table: string; count: number }[];
    profilesTrashed: string[];
  }>;
  suspectedOrphans: Array<{
    projectId: string;
    reason: 'dir_present_with_content';
    activeRowCounts: { table: string; count: number }[];
    firstSeenAt: string;
  }>;
  orphanProfilesTrashed: string[];
  purged: { table: string; deleted: number }[];
  /** 空项目集全局重置结果（宽限未到期 / 无残留 → undefined） */
  cleanReset?: CleanResetReport;
}

export interface OrphanState {
  /** 疑似孤儿项目 → 首次发现时刻（升级阈值起算）；保留键 __orphan_empty_since__ 存空项目集宽限起点（epoch ms） */
  [projectId: string]: { firstSeenAt: string } | number | undefined;
}

/** 空项目集全局重置结果（宽限期到期后彻底清除本地残留的明细） */
export interface CleanResetReport {
  /** 宽限起点（epoch ms） */
  emptySince: number;
  /** 画像 trash 是否被清除 */
  profilesTrashCleared: boolean;
  /** SOP 规则缓存是否被清空 */
  sopCacheCleared: boolean;
  /** 被物理删除的工具规则 id 列表 */
  removedTools: string[];
  /** 能力引用账本是否被清空 */
  capabilityRefsCleared: boolean;
  /** DB 各表强清的软删行数 */
  purged: { table: string; deleted: number }[];
}
