import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

/**
 * 误报豁免基线（引擎层共用，随 @zh/shared 导出）
 *
 * 基线持久化到 <projectRoot>/.zhshield/baseline.json（与 deps-baseline.json 同目录约定）。
 * 匹配键为 `ruleId:file:line:column`（file 归一化为相对 projectRoot 的正斜杠路径），
 * 引擎层只消费键集合，读写归本模块（共用接线），不把 .zhshield 路径约定带进具体引擎包。
 * 写入 tmp+rename 原子替换；读取失败/损坏/版本不符降级为 null（无基线行为），绝不抛异常。
 */

export interface BaselineEntry {
  ruleId: string;
  file: string;
  line: number;
  column: number;
  /**
   * 豁免理由：为什么这条可以不修。
   * 与产品的 `.zhshield/whitelist.yml` 豁免语言对齐（reason/operator/expiresAt），
   * 缺失视为早期版本遗留条目。
   */
  reason?: string;
  /** 责任人：谁认领了这条豁免。缺省时无法定位复核人。 */
  owner?: string;
  /** 到期时间（ISO）。过期后条目自动失效，问题重新计入报告。缺省视为永久豁免。 */
  expiresAt?: string;
}

/** 基线文件内容：持久化到 .zhshield/baseline.json 的顶层结构，version 当前固定为 1 */
export interface Baseline {
  version: 1;
  capturedAt: string;
  entries: BaselineEntry[];
}

/** 被基线豁免的一条问题：连同命中的条目一起带出，供报告层展示豁免理由而非只给一个计数 */
export interface SuppressedIssue<T> {
  issue: T;
  entry: BaselineEntry;
}

/**
 * 基线过滤结果。
 * @typeParam T 被过滤的问题元素类型（通常为 Issue），保留原类型以便调用方继续处理。
 */
export interface BaselineFilterResult<T> {
  kept: T[];
  suppressed: number;
  suppressedIssues: SuppressedIssue<T>[];
  /**
   * 活跃但本轮一条都没命中的条目（休眠）。
   * 休眠本身不违规——它可能在防护尚未出现的回归；但长期休眠的条目通常意味着
   * 该处问题已修复或条目本身已腐化，应当复核后移除，否则豁免清单会虚增成仪式。
   */
  dormantEntries: BaselineEntry[];
  /** 已过期的条目：已不参与匹配，留着只让清单看起来比实际防护范围更大，应复核后移除。 */
  expiredEntries: BaselineEntry[];
}

const BASELINE_VERSION = 1;
const BASELINE_DIR = '.zhshield';
const BASELINE_FILE = 'baseline.json';
const RE_PATH_SEPARATOR = /[\\/]/;

/** 文件归一化：绝对路径 → 相对 projectRoot；统一正斜杠（兼容 win32 反斜杠产出） */
export function normalizeBaselineFile(file: string, projectRoot: string): string {
  const resolved = isAbsolute(file) ? relative(projectRoot, file) : file;
  return resolved.split(RE_PATH_SEPARATOR).join('/');
}

/** 匹配键：ruleId:file:line:column。adapters 的 fingerprint 公式跨工具不一致
 *  （eslint `ruleId:file:line` vs gitleaks `gitleaks:RuleID:File:StartLine`），
 *  统一采用此稳定键；file 归一化为相对路径以兼容绝对/相对两种产出。 */
export function baselineEntryKey(entry: BaselineEntry): string {
  return `${entry.ruleId}:${entry.file}:${entry.line}:${entry.column}`;
}

/** 将 issue 形状对象转为基线条目（line/column 缺省 0，file 相对化） */
export function toBaselineEntry(
  issue: { ruleId: string; file: string; line?: number; column?: number },
  projectRoot: string,
): BaselineEntry {
  return {
    ruleId: issue.ruleId,
    file: normalizeBaselineFile(issue.file, projectRoot),
    line: issue.line ?? 0,
    column: issue.column ?? 0,
  };
}

/**
 * 条目当前是否仍生效：无 expiresAt 视为永久豁免（早期条目）；已到期或到期时间非法则失效。
 * 非法时间判为失效是刻意的保守选择——坏数据不该把问题永久藏起来。
 *
 * @param now 注入时钟以便测试，默认取当前时间。
 */
export function isBaselineEntryActive(entry: BaselineEntry, now: number = Date.now()): boolean {
  if (entry.expiresAt === undefined) return true;
  const expiresAtMs = Date.parse(entry.expiresAt);
  if (Number.isNaN(expiresAtMs)) return false;
  return expiresAtMs > now;
}

/** 基线 → 键集合（供引擎 O(1) 过滤）；已过期条目不进集合，其问题会重新计入报告 */
export function baselineKeySet(baseline: Baseline, now?: number): Set<string> {
  return new Set(
    baseline.entries.filter((e) => isBaselineEntryActive(e, now)).map((e) => baselineEntryKey(e)),
  );
}

/** 基线 → 键到条目的映射：过滤时需要回连命中的条目，才能把豁免理由带给报告层 */
function activeEntryMap(baseline: Baseline, now?: number): Map<string, BaselineEntry> {
  const map = new Map<string, BaselineEntry>();
  for (const entry of baseline.entries) {
    if (!isBaselineEntryActive(entry, now)) continue;
    map.set(baselineEntryKey(entry), entry);
  }
  return map;
}

/** 用基线过滤 issue 列表：命中基线键的 issue 移出并连同命中的条目一起记录（不修改原数组）。已过期条目不参与匹配。 */
export function filterIssuesByBaseline<
  T extends { ruleId: string; file: string; line?: number; column?: number },
>(
  issues: readonly T[],
  baseline: Baseline | null,
  projectRoot: string,
  now?: number,
): BaselineFilterResult<T> {
  if (!baseline || baseline.entries.length === 0) {
    return {
      kept: [...issues],
      suppressed: 0,
      suppressedIssues: [],
      dormantEntries: [],
      expiredEntries: [],
    };
  }
  const entries = activeEntryMap(baseline, now);
  const kept: T[] = [];
  const suppressedIssues: SuppressedIssue<T>[] = [];
  const matchedKeys = new Set<string>();
  for (const issue of issues) {
    const key = baselineEntryKey(toBaselineEntry(issue, projectRoot));
    const matched = entries.get(key);
    if (matched) {
      matchedKeys.add(key);
      suppressedIssues.push({ issue, entry: matched });
    } else {
      kept.push(issue);
    }
  }
  const dormantEntries = [...entries.values()].filter(
    (entry) => !matchedKeys.has(baselineEntryKey(entry)),
  );
  const expiredEntries = baseline.entries.filter((e) => !isBaselineEntryActive(e, now));
  return {
    kept,
    suppressed: suppressedIssues.length,
    suppressedIssues,
    dormantEntries,
    expiredEntries,
  };
}

/** 通用 JSON 读取：文件缺失 → null；validate 返回 null 表示结构/版本校验失败 → null；其他错误 → warn 并降级为 null（绝不抛异常）。warnTag 为日志前缀，warnOnNotFound 控制 ENOENT 是否也告警。 */
export async function readJsonBaseline<T>(
  filePath: string,
  validate: (parsed: unknown) => T | null,
  warnTag: string,
  warnOnNotFound = false,
): Promise<T | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf-8')) as unknown;
    return validate(parsed);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (warnOnNotFound || code !== 'ENOENT') {
      console.warn(
        `[${warnTag}] 读取失败，降级为无基线:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return null;
  }
}

/** 通用原子写入 JSON（mkdir + tmp+rename）：先写临时文件再重命名，避免读到半写内容 */
export async function writeJsonBaselineAtomic(
  dir: string,
  filePath: string,
  data: unknown,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmp, filePath);
}

/**
 * 通用「版本 + 采集时间 + 载荷」信封校验：顶层非对象 / 版本不符 / 缺 capturedAt /
 * 载荷形状不符 → null。载荷形状由 isPayload 判定，成功时返回 { capturedAt, payload }。
 */
export function parseVersionedEnvelope<TPayload>(
  parsed: unknown,
  expectedVersion: number,
  payloadKey: string,
  isPayload: (value: unknown) => value is TPayload,
): { capturedAt: string; payload: TPayload } | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== expectedVersion) return null;
  const { capturedAt } = record;
  if (typeof capturedAt !== 'string') return null;
  const payload = record[payloadKey];
  if (!isPayload(payload)) return null;
  return { capturedAt, payload };
}

/** `<projectRoot>/.zhshield/<fileName>` 基线的读写口 */
export interface BaselineIo<TRecord, TPayload> {
  path(projectRoot: string): string;
  load(projectRoot: string): Promise<TRecord | null>;
  save(projectRoot: string, payload: TPayload): Promise<TRecord>;
  clear(projectRoot: string): Promise<void>;
}

/**
 * 按文件配置生成基线读写口：路径约定、版本信封校验、读取降级为 null、tmp+rename 原子写
 * 全部单一来源。各基线文件形态一致，仅文件名 / 版本号 / 载荷键名 / 载荷判定 / 记录组装不同。
 *
 * @param config.warnOnNotFound ENOENT 是否也告警（默认否），用于暴露调用时序异常
 */
export function createBaselineIo<TRecord, TPayload>(config: {
  fileName: string;
  version: number;
  payloadKey: string;
  isPayload: (value: unknown) => value is TPayload;
  buildRecord: (capturedAt: string, payload: TPayload) => TRecord;
  warnTag: string;
  warnOnNotFound?: boolean;
}): BaselineIo<TRecord, TPayload> {
  const { fileName, version, payloadKey, isPayload, buildRecord, warnTag, warnOnNotFound } = config;
  const path = (projectRoot: string): string => join(projectRoot, BASELINE_DIR, fileName);
  return {
    path,
    load: (projectRoot) =>
      readJsonBaseline(
        path(projectRoot),
        (parsed) => {
          const envelope = parseVersionedEnvelope(parsed, version, payloadKey, isPayload);
          return envelope === null ? null : buildRecord(envelope.capturedAt, envelope.payload);
        },
        warnTag,
        warnOnNotFound,
      ),
    save: async (projectRoot, payload) => {
      const record = buildRecord(new Date().toISOString(), payload);
      await writeJsonBaselineAtomic(join(projectRoot, BASELINE_DIR), path(projectRoot), record);
      return record;
    },
    clear: async (projectRoot) => {
      await rm(path(projectRoot), { force: true });
    },
  };
}

// 刻意只做浅校验：补深层字段校验会改变既有降级行为
function isBaselineEntries(value: unknown): value is BaselineEntry[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'object' && entry !== null)
  );
}

const baselineIo = createBaselineIo<Baseline, BaselineEntry[]>({
  fileName: BASELINE_FILE,
  version: BASELINE_VERSION,
  payloadKey: 'entries',
  isPayload: isBaselineEntries,
  buildRecord: (capturedAt, entries) => ({ version: BASELINE_VERSION, capturedAt, entries }),
  warnTag: 'baseline',
});

export function baselinePath(projectRoot: string): string {
  return baselineIo.path(projectRoot);
}

/** 读取基线；文件缺失 / 版本不符 / 损坏 → null（降级为无基线行为） */
export function loadBaseline(projectRoot: string): Promise<Baseline | null> {
  return baselineIo.load(projectRoot);
}

/** 写入基线（tmp+rename 原子替换），返回落盘基线 */
export function saveBaseline(projectRoot: string, entries: BaselineEntry[]): Promise<Baseline> {
  return baselineIo.save(projectRoot, entries);
}

/** 清空基线文件；文件不存在时静默成功 */
export function clearBaseline(projectRoot: string): Promise<void> {
  return baselineIo.clear(projectRoot);
}

/** 从 issue 列表批量生成基线条目（供 CLI baseline capture 使用） */
export function issuesToBaselineEntries<
  T extends { ruleId: string; file: string; line?: number; column?: number },
>(issues: readonly T[], projectRoot: string): BaselineEntry[] {
  return issues.map((issue) => toBaselineEntry(issue, projectRoot));
}
