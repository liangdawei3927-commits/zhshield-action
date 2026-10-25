/**
 * 域级扫描历史的读回 IPC。
 *
 * 只读、只做入参校验：历史内容由 `domain-history.ts` 写入，这里不加工、不补造。
 * 入参一律走白名单 —— 域键与 blob 名都会拼进文件路径，任何未校验的字符串
 * 都可能变成 `../` 路径穿越。
 */

import {
  getLatestHistoryRecord,
  isDomainKey,
  listDomainHistory,
  readScanBlob,
  buildRecordFromFingerprints,
  normalizeFingerprint,
} from '../domain-history';
import type { DomainScanBlob, DomainScanRecord } from '../domain-history';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 默认返回条数：一屏够看，避免把 200 条一次性塞进渲染层 */
const DEFAULT_LIMIT = 50;

/** blob 名格式：sha256 前 16 位十六进制（与写入端一致） */
const BLOB_RE = /^[0-9a-f]{16}$/;

/**
 * 从「最近一次快照」回填一条只读记录（历史文件为空时使用）。
 *
 * 为什么需要：历史是本次升级才引入的，此前扫过的域没有 jsonl —— 若不做回填，
 * 用户打开就是空表，会以为历史功能没生效。回填只读一条、标记 `backfilled`，
 * 让「上次检查时间 / 分数 / 问题数」立刻可见；**不落盘**，下一次真正扫描后
 * 历史就会逐条累积。
 *
 * 兼容两种快照形态：
 * - 诊断类（`issues[]`，含 fingerprint）→ 直接相对化复用；
 * - 垃圾清理（`items[]`，无 fingerprint）→ 用 `类型 + 相对路径` 合成。
 */
async function snapshotFallbackRecord(
  projectPath: string,
  domain: string,
): Promise<DomainScanRecord | null> {
  try {
    const raw = await readFile(
      join(projectPath, '.zhshield', 'diagnostics', 'domains', `${domain}.json`),
      'utf-8',
    );
    const parsed = JSON.parse(raw) as {
      generatedAt?: string;
      timestamp?: string;
      issues?: Array<{ fingerprint?: string; severity?: string }>;
      items?: Array<{ type?: string; path?: string }>;
      summary?: { total?: number; error?: number; warning?: number; info?: number };
      dimensionScore?: { score?: number; version?: number };
      esloc?: number;
    };
    const scannedAt = parsed.generatedAt ?? parsed.timestamp;
    if (!scannedAt) return null;

    if (Array.isArray(parsed.items)) {
      const fingerprints = parsed.items.map(
        (item) => `garbage:${item.type ?? 'unknown'}:${normalizeFingerprint(item.path ?? '', projectPath)}`,
      );
      return {
        ...buildRecordFromFingerprints({
          domain,
          scannedAt,
          recordedAt: scannedAt,
          fingerprints,
          total: parsed.summary?.total ?? fingerprints.length,
          score: null,
          severityApplicable: false,
        }),
        backfilled: true,
      };
    }

    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    const fingerprints = issues
      .map((issue) => normalizeFingerprint(issue.fingerprint ?? '', projectPath))
      .filter((fingerprint) => fingerprint.length > 0);
    // 三档统计本质是「按 severity 累加」，不是三层条件判断 —— 写成查表自增，
    // 既不会被嵌套深度检测误读成深层分支，也不会在加第四档时继续加一层 else-if。
    const counts = { error: 0, warning: 0, info: 0 };
    for (const issue of issues) {
      const severity = issue.severity;
      if (severity === 'error' || severity === 'info' || severity === 'warning') {
        counts[severity] += 1;
      }
    }
    return {
      ...buildRecordFromFingerprints({
        domain,
        scannedAt,
        recordedAt: scannedAt,
        fingerprints,
        counts,
        total: parsed.summary?.total ?? issues.length,
        score: typeof parsed.dimensionScore?.score === 'number' ? parsed.dimensionScore.score : null,
        ...(parsed.dimensionScore?.version === undefined
          ? {}
          : { scoreVersion: parsed.dimensionScore.version }),
        ...(typeof parsed.esloc === 'number' && parsed.esloc > 0 ? { esloc: parsed.esloc } : {}),
      }),
      backfilled: true,
    };
  } catch {
    return null;
  }
}

/**
 * 某域的扫描历史（新 → 旧）。
 *
 * 返回的每条都带完整指纹集（写入时的 `sameAs` 指针已解压），
 * 渲染层可直接与上一条做 diff。历史文件为空但存在快照时，回填最后一条只读记录。
 */
export async function listDomainHistoryHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectPath: string,
  domain: string,
  limit?: number,
): Promise<DomainScanRecord[]> {
  if (!projectPath || typeof projectPath !== 'string') return [];
  if (!isDomainKey(domain)) return [];
  const size = typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : DEFAULT_LIMIT;
  try {
    const records = await listDomainHistory(projectPath, domain, size);
    if (records.length > 0) return records;
    const fallback = await snapshotFallbackRecord(projectPath, domain);
    return fallback ? [fallback] : [];
  } catch (err) {
    console.warn(
      '[engine:listDomainHistory] 读取失败:',
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/** 某次扫描的明细（未保存明细 / 损坏 → null） */
export async function getDomainScanBlobHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectPath: string,
  blob: string,
): Promise<DomainScanBlob | null> {
  if (!projectPath || typeof projectPath !== 'string') return null;
  if (typeof blob !== 'string' || !BLOB_RE.test(blob)) return null;
  try {
    return await readScanBlob(projectPath, blob);
  } catch {
    return null;
  }
}

/** 某域最近一次扫描记录（供分类页显示「上次检查 · 时间」） */
export async function getLatestDomainScanHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectPath: string,
  domain: string,
): Promise<DomainScanRecord | null> {
  if (!projectPath || typeof projectPath !== 'string') return null;
  if (!isDomainKey(domain)) return null;
  try {
    const latest = await getLatestHistoryRecord(projectPath, domain);
    if (latest) return latest;
    return await snapshotFallbackRecord(projectPath, domain);
  } catch {
    return null;
  }
}
