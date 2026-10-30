/**
 * 备份记录持久化（从 ipc/backup.ts 按功能域拆出）
 *
 * 专注 <userData>/backup-records.json 的读写、kernel 结果的 IPC 序列化。
 * 上层（IPC 处理器 / 调度 / 健康快照）按需引用。
 */
import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupOrchestrator } from '@zh/kernel';

// @zh/kernel 顶层同时导出旧版增量备份与新版一键备份的 BackupResult/BackupRecord，
// 显式命名导出优先导致顶层类型指向旧版。此处从实例方法签名推导，避免命名冲突。
/** kernel 一键备份的执行结果（按实例方法签名推导，规避顶层同名旧类型） */
export type KernelBackupResult = Awaited<ReturnType<BackupOrchestrator['execute']>>;
/** 单条备份记录（取 getRecords() 返回数组的元素类型） */
export type KernelBackupRecord = ReturnType<BackupOrchestrator['getRecords']>[number];

/** 序列化后的备份结果（kernel 的 timestamp 为 Date，IPC 传输需转 ISO 字符串） */
export interface SerializedBackupResult {
  projectId: string;
  projectName: string;
  trigger: string;
  overallStatus: string;
  timestamp: string;
  duration: number;
  error?: string;
  results: Array<Record<string, unknown>>;
}

const RECORDS_FILE = 'backup-records.json';
const MAX_RECORDS = 100;

function recordsPath(): string {
  return join(app.getPath('userData'), RECORDS_FILE);
}

/** 读取持久化的备份记录；文件不存在或损坏时返回空数组 */
export async function loadRecordsFromDisk(): Promise<KernelBackupRecord[]> {
  const file = recordsPath();
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as unknown;
    return Array.isArray(parsed) ? (parsed as KernelBackupRecord[]) : [];
  } catch (err) {
    console.warn('[backup] 历史记录解析失败:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** 将当前内存中的记录持久化到磁盘（仅保留最近 MAX_RECORDS 条） */
export async function persistRecords(orchestrator: BackupOrchestrator): Promise<void> {
  try {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(
      recordsPath(),
      JSON.stringify(orchestrator.getRecords().slice(0, MAX_RECORDS), null, 2),
      'utf-8',
    );
  } catch (err) {
    console.warn('[backup] 记录持久化失败:', err instanceof Error ? err.message : String(err));
  }
}

export function serializeResult(result: KernelBackupResult): SerializedBackupResult {
  return {
    projectId: result.projectId,
    projectName: result.projectName,
    trigger: result.trigger,
    overallStatus: result.overallStatus,
    timestamp: result.timestamp.toISOString(),
    duration: result.duration,
    ...(result.error ? { error: result.error } : {}),
    results: result.results.map((r) => ({ ...r })),
  };
}
