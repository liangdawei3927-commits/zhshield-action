/**
 * 域级扫描历史（每次扫描一条记录，append-only）。
 *
 * 为什么需要它：`diagnostics/domains/<domain>.json` 是**单文件覆盖写**，
 * 扫 10 次只留最后 1 次 —— 于是「今天为什么掉 5 分」「这条问题是我修的还是它自己消失的」
 * 永远答不出来。报告中心只有总分曲线，且每个点由 10 个域各自不同时间的快照拼成，
 * 无法归因。本模块把每次域扫描落成可回溯、可 diff 的历史。
 *
 * 三层保留（呼应「能否再生」判据）：
 * - L1 摘要：时间 / 分数 / 问题数 / severity 分布 —— **每次必留**，不可再生（覆盖即丢）
 * - L2 指纹集：本条问题的稳定指纹 —— **每次必留**，用于算新增 / 修复 / 遗留
 * - L3 明细：该次扫描的问题正文 —— 仅「指纹集发生变化」时写，按内容 hash 去重
 *
 * 存储：`<project>/.zhshield/history/`
 * - `<domain>.jsonl`      每次扫描一行（最近 HISTORY_LIMIT 条，超出滚动丢弃最旧）
 * - `blobs/<hash>.json`   某次变化时的明细快照（内容寻址，相同内容只存一份）
 *
 * 关键设计约束：
 * 1. **指纹必须相对化**。原始 fingerprint 形如
 *    `duplicated-code:/Users/xxx/project/src/a.ts:5`，含绝对路径 —— 项目换目录或换机器后
 *    全部指纹变化，diff 会误报「全消失 + 全新增」。这里统一转成相对项目根的路径。
 * 2. **重复扫描不重复记**。同一份快照被再次写盘（例如打开页面触发回写）时，
 *    `scannedAt + fingerprintsHash` 相同 → 跳过，避免伪造出「又扫了一次」。
 * 3. **相同指纹集只存指针**。refactor 动辄 663 条，一天扫 10 次内容几乎不变；
 *    第 2 次起写 `sameAs` 指向上一条，读取时向前回溯，磁盘占用降一个量级。
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiagnosticEntry } from './zh-diagnostics-types';

/** 每域保留的摘要条数（约 10 次/天 → 20 天） */
export const HISTORY_LIMIT = 200;

/** 域标识白名单：与 IPC 层一致，防路径穿越 */
const DOMAIN_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * blob 文件名格式：sha256 前 16 位十六进制。
 * **不能复用 DOMAIN_RE** —— hex 可能以数字开头（如 `3f9a…`），会被域名规则误拒，
 * 表现为「明细写了却没落盘」。
 */
const BLOB_NAME_RE = /^[0-9a-f]{16}$/;

/** 一次域扫描的摘要记录（落进 `<domain>.jsonl` 的一行） */
export interface DomainScanRecord {
  /** 稳定标识：scannedAt + 指纹集 hash，同一次扫描恒等 */
  scanId: string;
  domain: string;
  /** 扫描时间（快照 generatedAt） */
  scannedAt: string;
  /** 记录写入时间（与 scannedAt 不同：补写旧快照时会晚很多） */
  recordedAt: string;
  /** 该域分数；该域不出分时为 null（不拿 0 冒充） */
  score: number | null;
  /** 评分算法版本；跨版本不参与对比 */
  scoreVersion?: number;
  total: number;
  error: number;
  warning: number;
  info: number;
  /**
   * 该域的问题是否带严重级别维度。
   * `false`（如垃圾清理只有 dead-code 类型、无 severity）时 error/warning/info 全为 0，
   * 读取方**不得**据此推断「这批问题都是 info」。
   */
  severityApplicable?: boolean;
  /** 项目 ESLOC（密度归一化分母，可比性所需） */
  esloc?: number;
  /** 指纹集 hash（相对化 + 排序后） */
  fingerprintsHash: string;
  /** 完整指纹集；与上一条相同时省略，由 sameAs 指向 */
  fingerprints?: string[];
  /** 指向承载同一指纹集的更早记录 */
  sameAs?: string;
  /** 扫描口径（文件数 / 跳过数），缺失表示该域不提供 */
  coverage?: { files?: number; skipped?: number };
  /** L3 明细 blob 名（不含路径与扩展名）；null = 本次未保存明细 */
  blob?: string | null;
  /**
   * true = 该条由「最近一次快照」临时回填，从未真正落进 jsonl。
   *
   * 用途：升级到「有历史」版本之前扫过的域，历史文件是空的 —— 此时用现存快照
   * 生成一条只读记录，用户打开页面就能看到上次检查的时间和问题数，
   * 而不是看到一张空表还以为功能没生效。该条不参与写入、不产生 blob。
   */
  backfilled?: boolean;
}

/** 某次扫描的完整明细（L3） */
export interface DomainScanBlob {
  scanId: string;
  domain: string;
  scannedAt: string;
  entries: readonly DiagnosticEntry[];
}

/** 两次扫描的差异（纯计算结果，供「涨了还是跌了」使用） */
export interface ScanDiff {
  added: readonly string[];
  removed: readonly string[];
  persisting: number;
  scoreDelta: number | null;
  totalDelta: number;
  severityDelta: { error: number; warning: number; info: number };
}

function historyDir(projectPath: string): string {
  return join(projectPath, '.zhshield', 'history');
}

function historyFile(projectPath: string, domain: string): string | null {
  if (!DOMAIN_RE.test(domain)) return null;
  return join(historyDir(projectPath), `${domain}.jsonl`);
}

function blobFile(projectPath: string, blob: string): string | null {
  if (!BLOB_NAME_RE.test(blob)) return null;
  return join(historyDir(projectPath), 'blobs', `${blob}.json`);
}

function sha16(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * 指纹相对化：把 `规则:绝对路径:行号` 中的项目前缀剥掉。
 *
 * 只做前缀替换（不做路径归一化的其他加工）：指纹的其余部分由上游生成，
 * 这里改得越多，越容易与「快照里那份」对不上。
 */
export function normalizeFingerprint(fingerprint: string, projectPath: string): string {
  if (!fingerprint) return '';
  if (!projectPath) return fingerprint;
  const prefix = projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
  return fingerprint.split(prefix).join('');
}

/** 指纹集 hash：排序后拼接，避免顺序抖动造成假变化 */
export function hashFingerprints(fingerprints: readonly string[]): string {
  return sha16([...fingerprints].sort().join('\n'));
}

/**
 * 由「已相对化的指纹集」构造摘要记录。
 *
 * 供两类来源共用：走归一化诊断条目的域（inspect/refactor/… 由 buildScanRecord 调用），
 * 以及结构不同的域（垃圾清理的 items 只有 type/path/reason，没有 fingerprint）。
 */
export function buildRecordFromFingerprints(input: {
  domain: string;
  scannedAt: string;
  recordedAt: string;
  fingerprints: readonly string[];
  counts?: { error: number; warning: number; info: number };
  total?: number;
  score: number | null;
  scoreVersion?: number;
  esloc?: number;
  coverage?: { files?: number; skipped?: number };
  severityApplicable?: boolean;
}): DomainScanRecord {
  const fingerprints = [...input.fingerprints];
  const counts = input.counts ?? { error: 0, warning: 0, info: 0 };
  const fingerprintsHash = hashFingerprints(fingerprints);
  return {
    scanId: sha16(`${input.domain}|${input.scannedAt}|${fingerprintsHash}`),
    domain: input.domain,
    scannedAt: input.scannedAt,
    recordedAt: input.recordedAt,
    score: input.score,
    ...(input.scoreVersion === undefined ? {} : { scoreVersion: input.scoreVersion }),
    total: input.total ?? fingerprints.length,
    error: counts.error,
    warning: counts.warning,
    info: counts.info,
    ...(input.severityApplicable === false ? { severityApplicable: false } : {}),
    ...(input.esloc === undefined ? {} : { esloc: input.esloc }),
    fingerprintsHash,
    fingerprints,
    ...(input.coverage ? { coverage: input.coverage } : {}),
  };
}

/** 由一次快照构造摘要记录（不落盘，便于单测） */
export function buildScanRecord(input: {
  domain: string;
  scannedAt: string;
  recordedAt: string;
  projectPath: string;
  issues: readonly DiagnosticEntry[];
  score: number | null;
  scoreVersion?: number;
  esloc?: number;
  coverage?: { files?: number; skipped?: number };
}): DomainScanRecord {
  const fingerprints = input.issues
    .map((entry) => normalizeFingerprint(entry.fingerprint, input.projectPath))
    .filter((fp) => fp.length > 0);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const entry of input.issues) counts[entry.severity] += 1;
  return buildRecordFromFingerprints({
    domain: input.domain,
    scannedAt: input.scannedAt,
    recordedAt: input.recordedAt,
    fingerprints,
    counts,
    total: input.issues.length,
    score: input.score,
    ...(input.scoreVersion === undefined ? {} : { scoreVersion: input.scoreVersion }),
    ...(input.esloc === undefined ? {} : { esloc: input.esloc }),
    ...(input.coverage ? { coverage: input.coverage } : {}),
  });
}

/** 解析 jsonl 文本；坏行跳过（不因一行损坏丢掉整段历史） */
export function parseHistoryLines(text: string): DomainScanRecord[] {
  const records: DomainScanRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as DomainScanRecord;
      if (parsed && typeof parsed.scanId === 'string' && typeof parsed.domain === 'string') {
        records.push(parsed);
      }
    } catch {
      // 单行损坏（例如进程被杀导致半行写入）→ 跳过，保留其余历史
    }
  }
  return records;
}

/**
 * 解压 `sameAs` 指针：把省略的指纹集从更早记录回溯补齐。
 *
 * 不做原地修改（返回新数组），调用方拿到的是「每一条都自带完整指纹集」的视图。
 */
export function resolveFingerprints(records: readonly DomainScanRecord[]): DomainScanRecord[] {
  const byScanId = new Map<string, DomainScanRecord>();
  const resolved: DomainScanRecord[] = [];
  for (const record of records) {
    let current = record;
    if (!current.fingerprints && current.sameAs) {
      const source = byScanId.get(current.sameAs);
      if (source?.fingerprints) current = { ...current, fingerprints: source.fingerprints };
    }
    if (current.fingerprints) byScanId.set(current.scanId, current);
    resolved.push(current);
  }
  return resolved;
}

/**
 * 追加一次扫描记录。
 *
 * 行为：
 * - 同一次扫描（scanId 相同）已存在 → 直接返回 `duplicate`，不重复记；
 * - 指纹集与上一条相同 → 只写 `sameAs` 指针（省体积），且**不写明细 blob**；
 * - 指纹集发生变化且调用方给了 `entries` → 写一份明细 blob（内容寻址，幂等）；
 * - 超过 HISTORY_LIMIT → 覆盖写最近 HISTORY_LIMIT 条（沙箱禁止 unlink，故用覆盖写而非删除）。
 */
export async function appendDomainHistory(
  projectPath: string,
  record: DomainScanRecord,
  entries?: readonly DiagnosticEntry[],
  limit = HISTORY_LIMIT,
): Promise<'appended' | 'duplicate' | 'skipped'> {
  const file = historyFile(projectPath, record.domain);
  if (!file) return 'skipped';
  const max = Math.max(1, limit);
  const existing = await readHistoryFile(file);
  if (existing.some((item) => item.scanId === record.scanId)) return 'duplicate';

  const previous = existing.at(-1);
  const changed = !previous || previous.fingerprintsHash !== record.fingerprintsHash;

  let withBlob: DomainScanRecord = record;
  if (changed && entries && entries.length > 0) {
    const blob = await writeScanBlob(projectPath, record, entries);
    if (blob) withBlob = { ...record, blob };
  }

  const compact: DomainScanRecord =
    previous && !changed
      ? { ...withBlob, fingerprints: undefined, sameAs: previous.scanId }
      : withBlob;

  // 先 append（最常见路径，一次写一行），超限时再整体裁剪
  await mkdir(historyDir(projectPath), { recursive: true });
  await appendFile(file, `${JSON.stringify(compact)}\n`, 'utf-8');

  if (existing.length + 1 > max) {
    const kept = [...existing, compact].slice(-max);
    await writeFile(file, kept.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf-8');
  }
  return 'appended';
}

async function readHistoryFile(file: string): Promise<DomainScanRecord[]> {
  try {
    return parseHistoryLines(await readFile(file, 'utf-8'));
  } catch {
    return [];
  }
}

/** 读取某域历史（新 → 旧，指纹集已解压） */
export async function listDomainHistory(
  projectPath: string,
  domain: string,
  limit = HISTORY_LIMIT,
): Promise<DomainScanRecord[]> {
  const file = historyFile(projectPath, domain);
  if (!file) return [];
  const records = await readHistoryFile(file);
  return resolveFingerprints(records).slice(-Math.max(1, limit)).reverse();
}

/** 某域最近一次扫描记录（无历史 → null） */
export async function getLatestHistoryRecord(
  projectPath: string,
  domain: string,
): Promise<DomainScanRecord | null> {
  const records = await listDomainHistory(projectPath, domain, 1);
  return records[0] ?? null;
}

/** 读取某次扫描的明细；未保存 / 损坏 → null */
export async function readScanBlob(
  projectPath: string,
  blob: string,
): Promise<DomainScanBlob | null> {
  const file = blobFile(projectPath, blob);
  if (!file) return null;
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as DomainScanBlob;
  } catch {
    return null;
  }
}

/**
 * 写入明细 blob（内容寻址）。
 *
 * 只在调用方判定「指纹集发生变化」时调用；同一内容重复写同名文件，幂等。
 * blob 名 = 内容 hash，因此「内容没变但指纹集变了」这种情况不会重复占空间。
 */
export async function writeScanBlob(
  projectPath: string,
  record: DomainScanRecord,
  entries: readonly DiagnosticEntry[],
): Promise<string | null> {
  const blob: DomainScanBlob = {
    scanId: record.scanId,
    domain: record.domain,
    scannedAt: record.scannedAt,
    entries,
  };
  const payload = JSON.stringify(blob);
  const name = sha16(payload);
  const file = blobFile(projectPath, name);
  if (!file) return null;
  try {
    await mkdir(join(historyDir(projectPath), 'blobs'), { recursive: true });
    await writeFile(file, payload, 'utf-8');
    return name;
  } catch (err) {
    console.warn('[domain-history] 明细写入失败:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * 两次扫描的差异。
 *
 * `prev` 为空（首次扫描）时：added = 本次全部，scoreDelta = null（没有基线就不编造涨跌）。
 */
export function diffScans(
  prev: DomainScanRecord | null,
  curr: DomainScanRecord,
): ScanDiff {
  const current = new Set(curr.fingerprints ?? []);
  const before = new Set(prev?.fingerprints ?? []);
  const added = [...current].filter((fp) => !before.has(fp));
  const removed = [...before].filter((fp) => !current.has(fp));
  const persisting = [...current].filter((fp) => before.has(fp)).length;
  const scoreDelta =
    prev && prev.score !== null && curr.score !== null ? curr.score - prev.score : null;
  return {
    added,
    removed,
    persisting,
    scoreDelta: scoreDelta === null ? null : Math.round(scoreDelta * 10) / 10,
    totalDelta: prev ? curr.total - prev.total : curr.total,
    severityDelta: {
      error: curr.error - (prev?.error ?? 0),
      warning: curr.warning - (prev?.warning ?? 0),
      info: curr.info - (prev?.info ?? 0),
    },
  };
}

/**
 * 有历史记录的域白名单。
 *
 * 注意：包含 `garbage` —— 它虽有独立落盘路径（`writeGarbageSnapshot`），
 * 但同样属于「有分数、也该有历史」的域；而 `DiagnosticSource` 联合类型不含 garbage，
 * 故这里用独立常量而不是复用该类型，避免把类型断言写歪。
 */
export const HISTORY_DOMAINS = [
  'guard',
  'inspect',
  'refactor',
  'deps',
  'techdebt',
  'security',
  'performance',
  'garbage',
] as const;

export type HistoryDomain = (typeof HISTORY_DOMAINS)[number];

/** IPC 入参校验：域键必须在白名单内，否则拒绝（防路径穿越 / 拼错域名写出野文件） */
export function isDomainKey(value: string): value is HistoryDomain {
  return (HISTORY_DOMAINS as readonly string[]).includes(value);
}

/**
 * 回填某次扫描的域分数。
 *
 * 为什么需要：扫描当场只有 inspect 能出分（quality）；其余域的分数要等「汇总」时
 * 才由 buildHealthDimensions 按各域最新快照算出。此时按 scanId 精确回填**已有那条**，
 * 不新造记录 —— 否则同一次扫描会在历史里出现两条（一条无分、一条有分），看起来像扫了两次。
 *
 * 找不到该 scanId（历史被裁剪或本次未记录）→ 返回 false，调用方无需处理。
 */
export async function attachScore(
  projectPath: string,
  domain: string,
  scanId: string,
  score: number,
  scoreVersion?: number,
): Promise<boolean> {
  const file = historyFile(projectPath, domain);
  if (!file) return false;
  const records = await readHistoryFile(file);
  const index = records.findIndex((item) => item.scanId === scanId);
  if (index < 0) return false;
  const target = records[index];
  if (target.score === score) return false;
  records[index] = {
    ...target,
    score,
    ...(scoreVersion === undefined ? {} : { scoreVersion }),
  };
  try {
    await writeFile(file, records.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf-8');
    return true;
  } catch (err) {
    console.warn(
      '[domain-history] 回填分数失败:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
