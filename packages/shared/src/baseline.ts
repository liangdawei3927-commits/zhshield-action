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
}

/** 基线文件内容：持久化到 .zhshield/baseline.json 的顶层结构，version 当前固定为 1 */
export interface Baseline {
  version: 1;
  capturedAt: string;
  entries: BaselineEntry[];
}

/**
 * 基线过滤结果。
 * @typeParam T 被过滤的问题元素类型（通常为 Issue），kept 保留原类型以便调用方继续处理。
 */
export interface BaselineFilterResult<T> {
  kept: T[];
  suppressed: number;
}

const BASELINE_VERSION = 1;
const BASELINE_DIR = '.zhshield';
const BASELINE_FILE = 'baseline.json';
const RE_PATH_SEPARATOR = /[\\/]/;

export function baselinePath(projectRoot: string): string {
  return join(projectRoot, BASELINE_DIR, BASELINE_FILE);
}

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

/** 基线 → 键集合（供引擎 O(1) 过滤） */
export function baselineKeySet(baseline: Baseline): Set<string> {
  return new Set(baseline.entries.map((e) => baselineEntryKey(e)));
}

/** 用基线过滤 issue 列表：命中基线键的 issue 移除并计数（不修改原数组） */
export function filterIssuesByBaseline<
  T extends { ruleId: string; file: string; line?: number; column?: number },
>(issues: readonly T[], baseline: Baseline | null, projectRoot: string): BaselineFilterResult<T> {
  if (!baseline || baseline.entries.length === 0) {
    return { kept: [...issues], suppressed: 0 };
  }
  const keys = baselineKeySet(baseline);
  const kept: T[] = [];
  let suppressed = 0;
  for (const issue of issues) {
    const entry = toBaselineEntry(issue, projectRoot);
    if (keys.has(baselineEntryKey(entry))) {
      suppressed += 1;
    } else {
      kept.push(issue);
    }
  }
  return { kept, suppressed };
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

function validateBaseline(parsed: unknown): Baseline | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { version, capturedAt, entries } = parsed as Partial<Baseline>;
  if (
    version !== BASELINE_VERSION ||
    typeof capturedAt !== 'string' ||
    !Array.isArray(entries) ||
    entries.some((e) => typeof e !== 'object' || e === null)
  ) {
    return null;
  }
  return {
    version: BASELINE_VERSION,
    capturedAt,
    entries: entries as BaselineEntry[],
  };
}

/** 读取基线；文件缺失 / 版本不符 / 损坏 → null（降级为无基线行为） */
export function loadBaseline(projectRoot: string): Promise<Baseline | null> {
  return readJsonBaseline(baselinePath(projectRoot), validateBaseline, 'baseline');
}

/** 写入基线（tmp+rename 原子替换），返回落盘基线 */
export async function saveBaseline(
  projectRoot: string,
  entries: BaselineEntry[],
): Promise<Baseline> {
  const baseline: Baseline = {
    version: BASELINE_VERSION,
    capturedAt: new Date().toISOString(),
    entries,
  };
  await writeJsonBaselineAtomic(
    join(projectRoot, BASELINE_DIR),
    baselinePath(projectRoot),
    baseline,
  );
  return baseline;
}

/** 清空基线文件；文件不存在时静默成功 */
export async function clearBaseline(projectRoot: string): Promise<void> {
  await rm(baselinePath(projectRoot), { force: true });
}

/** 从 issue 列表批量生成基线条目（供 CLI baseline capture 使用） */
export function issuesToBaselineEntries<
  T extends { ruleId: string; file: string; line?: number; column?: number },
>(issues: readonly T[], projectRoot: string): BaselineEntry[] {
  return issues.map((issue) => toBaselineEntry(issue, projectRoot));
}
