import type { SyncResult } from '../_meta/sop-types';
import type { SyncPolicyOptions } from './sop-sync-policy';
import type { SopSyncState } from './sop-version-store';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 失败原因分类：供 UI 用人话解释「为什么同步没成功」，避免只透出英文 reason 码 */
export type SyncFailureKind = 'none' | 'network' | 'compatibility' | 'signature' | 'unknown';

/** 同步健康度快照（跨 IPC 传给渲染进程的完整形态） */
export interface SyncHealthDetail {
  /** 降级等级：0 正常 / 1-3 待更新 / 4 严重过期 */
  level: 0 | 1 | 2 | 3 | 4;
  /** 是否曾经成功同步过：false 表示从未接入云端，而非「过期」 */
  everSucceeded: boolean;
  /** 最近一次成功同步的 ISO 时间 */
  lastSuccessAt: string | null;
  /** 最近一次尝试同步的 ISO 时间（无论成败） */
  lastAttemptAt: string | null;
  /** 最近一次失败原因原文；最近一次成功则为 null */
  lastError: string | null;
  /** 距最近一次成功同步的天数（含小数）；从未成功为 null */
  daysSinceSuccess: number | null;
  /** lastError 的语义分类 */
  failureKind: SyncFailureKind;
}

/**
 * SopSyncScheduler — 同步调度与健康度评估
 *
 * 负责后台定时同步调度、在线状态与降级健康度（Level 0-4）/过期判断。
 * 同步编排器在每次成功同步后调用 recordSync()、失败后调用 recordSyncFailure()。
 *
 * 状态可在进程启动时经 hydrate() 由磁盘恢复：健康度必须基于「历史上真实同步成功过的时间」，
 * 而不是「本进程是否同步成功过」——后者在桌面端每次重启都会归零，
 * 会把一天的正常离线误报成严重过期。
 */
export class SopSyncScheduler {
  private lastSyncTime: Date | null = null;
  private lastAttemptTime: Date | null = null;
  private lastError: string | null = null;
  private everSucceeded = false;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private online = true;

  constructor(private readonly syncPolicy: Required<SyncPolicyOptions>) {}

  /** 当前是否在线 */
  get isOnline(): boolean {
    return this.online;
  }

  // ─── 状态恢复 ──────────────────────────────────────────────

  /**
   * 从持久化状态恢复：进程启动时调用一次，使健康度基线来自磁盘而非空内存。
   */
  hydrate(state: SopSyncState): void {
    this.lastSyncTime = parseIsoDate(state.lastSuccessAt);
    this.lastAttemptTime = parseIsoDate(state.lastAttemptAt);
    this.lastError = state.lastError;
    // 标志位与时间戳取或，与 version-store 的解析口径保持一致
    this.everSucceeded = state.everSucceeded || this.lastSyncTime !== null;
  }

  /** 导出当前状态用于持久化 */
  getState(): SopSyncState {
    return {
      lastSuccessAt: this.lastSyncTime?.toISOString() ?? null,
      lastAttemptAt: this.lastAttemptTime?.toISOString() ?? null,
      lastError: this.lastError,
      everSucceeded: this.everSucceeded,
    };
  }

  // ─── 同步调度 ──────────────────────────────────────────────

  /**
   * 启动后台定时同步（7.5 节 触发方式 2）
   */
  startPeriodicSync(onSync: () => Promise<SyncResult>): void {
    if (this.syncTimer) return;

    this.syncTimer = setInterval(() => {
      void onSync();
    }, this.syncPolicy.syncInterval);
  }

  /**
   * 停止定时同步
   */
  stopPeriodicSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * 设置在线状态
   */
  setOnline(online: boolean): void {
    this.online = online;
  }

  /**
   * 记录最近一次成功同步（由同步编排器调用）
   *
   * 成功的定义是「确实与云端完成了一次有效交互」，包含 already_latest 与紧急更新。
   */
  recordSync(): void {
    const now = new Date();
    this.lastSyncTime = now;
    this.lastAttemptTime = now;
    this.lastError = null;
    this.everSucceeded = true;
  }

  /**
   * 记录最近一次失败尝试（由同步编排器调用）
   *
   * 不影响 lastSyncTime —— 失败不刷新「上次成功」，否则过期判断会被失败掩盖。
   */
  recordSyncFailure(reason: string): void {
    this.lastAttemptTime = new Date();
    this.lastError = reason;
  }

  // ─── 降级策略（10.5 节） ───────────────────────────────────

  /**
   * 获取当前同步状态级别
   * Level 0: 正常  Level 1-3: 降级  Level 4: 严重过期
   */
  getSyncHealthLevel(): 0 | 1 | 2 | 3 | 4 {
    if (!this.lastSyncTime) return 4;

    const daysSinceSync = (Date.now() - this.lastSyncTime.getTime()) / DAY_MS;

    if (daysSinceSync <= 1) return 0;
    if (daysSinceSync <= 3) return 1;
    if (daysSinceSync <= 7) return 2;
    if (daysSinceSync <= 14) return 3;
    return 4;
  }

  /** 完整健康度快照（供 IPC 与 UI 判断四态文案） */
  getSyncHealthDetail(): SyncHealthDetail {
    const now = Date.now();
    return {
      level: this.getSyncHealthLevel(),
      everSucceeded: this.everSucceeded,
      lastSuccessAt: this.lastSyncTime?.toISOString() ?? null,
      lastAttemptAt: this.lastAttemptTime?.toISOString() ?? null,
      lastError: this.lastError,
      daysSinceSuccess: this.lastSyncTime ? (now - this.lastSyncTime.getTime()) / DAY_MS : null,
      failureKind: classifyFailure(this.lastError),
    };
  }

  /**
   * 判断规则是否可能过期（需要显示警告）
   */
  isStale(): boolean {
    if (!this.lastSyncTime) return true;
    const daysSinceSync = (Date.now() - this.lastSyncTime.getTime()) / DAY_MS;
    return daysSinceSync > this.syncPolicy.staleThresholdDays;
  }
}

/** 解析 ISO 时间字符串；非法或缺失返回 null */
function parseIsoDate(value: string | null): Date | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

/**
 * 把同步失败原因归类。
 *
 * 只做字符串匹配、不猜语义：认不出的原因保留 'unknown' 并由 UI 原样透出，
 * 不做「大概是网络问题」这种替用户编解释的事。
 */
/** 失败原因归类用的签名类信号词（模块级常量：避免每次调用重建正则对象） */
const SIGNATURE_HINT_RE = /signature|verify|verification|hash mismatch|integrity/i;

function classifyFailure(reason: string | null): SyncFailureKind {
  if (!reason) return 'none';
  // 服务侧暂时不可用（5xx / 超时）与"完全连不上"对用户是同一件事，都归 network
  if (
    reason === 'network_error' ||
    reason === 'offline' ||
    reason === 'timeout' ||
    reason === 'http_error'
  ) {
    return 'network';
  }
  if (reason === 'compatibility_error') return 'compatibility';
  // 显式列出：验签失败是安全事件，不能靠下面的正则"碰巧"命中
  if (reason === 'signature_rejected') return 'signature';
  if (SIGNATURE_HINT_RE.test(reason)) return 'signature';
  // auth_error / decode_error / apply_error 保持 unknown：由 UI 原样透出 lastError 原文，
  // 不替用户编"大概是网络问题"这种解释（新增分类须同步改 electron.d.ts 手写联合类型）。
  return 'unknown';
}
