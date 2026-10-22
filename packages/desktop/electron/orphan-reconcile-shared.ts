import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLogger } from '@zh/shared';
import type { getDb } from './ipc-context';

// ─── 常量 ───

/** 画像持久化目录（与 fingerprint PROFILE_DIR 约定一致，用 os 保证与画像实际落盘位置一致） */
export const PROFILES_DIR = path.join(os.homedir(), '.zhshield', 'profiles');
/** 疑似孤儿状态文件 */
export const STATE_FILE = path.join(os.homedir(), '.zhshield', 'orphan-state.json');
/** 疑似孤儿升级为确认孤儿的阈值（天） */
export const UPGRADE_DAYS = 30;
/** TTL 物理清除阈值（天） */
export const TTL_DAYS = 180;
/** 空项目集全局重置宽限期（天）：删除全部项目后进入宽限，超期则彻底清除本地残留 */
export const EMPTY_GRACE_DAYS = 7;
/** 空项目集宽限期毫秒数 */
export const EMPTY_GRACE_MS = EMPTY_GRACE_DAYS * 24 * 60 * 60 * 1000;
/** state 中空项目集宽限起点的保留键（与 projectId 索引键区分） */
export const EMPTY_SINCE_KEY = '__orphan_empty_since__';

/** 孤儿对账用到的 DB 句柄类型（避免各处重复书写 ReturnType<typeof getDb>） */
export type Db = ReturnType<typeof getDb>;

// 画像 key 归一正则（与 fingerprint profile-store.ts 等价，不修改该包）
const NON_KEY_CHARS_RE = /[^a-zA-Z0-9_-]/g;
const FORWARD_SLASH_RE = /\//g;
const BACKSLASH_RE = /\\/g;
const LEADING_UNDERSCORE_RE = /^_+/;

// ─── 模块级单例 ───

/** 审计日志单例（写入失败静默 catch，永不阻断清理主流程） */
export const auditLog = new AuditLogger();

/** 统一 warn 输出（错误对象只取 message） */
export function warn(msg: string, err: unknown): void {
  console.warn(msg, err instanceof Error ? err.message : String(err));
}

// ─── 画像 key 归一（等价于 fingerprint normalizeKey） ───

export function normalizeKey(projectPath: string): string {
  return projectPath
    .replace(FORWARD_SLASH_RE, '_')
    .replace(BACKSLASH_RE, '_')
    .replace(LEADING_UNDERSCORE_RE, '')
    .replace(NON_KEY_CHARS_RE, '_');
}

/** 画像文件 key 是否匹配某项目 key（覆盖多引擎后缀如 `_zhiyan-codeshield`） */
export function profileKeyMatches(fileKey: string, expectedKey: string): boolean {
  return fileKey === expectedKey || fileKey.startsWith(`${expectedKey}_`);
}
