import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * diff 覆盖率（`scope: diff`）—— 只统计「本次改动行」的覆盖率。
 *
 * 为什么必须真算，而不是拿全量覆盖率顶替（2026-10-29）：
 * 云端规则 `guard.block.official.test-coverage` 写的是 `scope: diff` + `threshold: 80`。
 * 项目整体覆盖率 63% 但新增代码 100% 覆盖，与整体 85% 而新增代码 0% 覆盖，
 * 是完全相反的两种交付质量。用全量数代入，两个方向都会给出错误结论。
 *
 * 口径（三条写死，避免各处自己解释）：
 *   ① **基线**：与目标分支的 `merge-base` 比（等价于「本分支引入的改动」）。
 *      解析不到基线 ⇒ 不判定，绝不退化成全量或空 diff。
 *   ② **改动行**：`git diff --unified=0 <base>` 的 `+` 侧行号（含未提交改动，
 *      因为比较对象是 base 与工作区）。
 *   ③ **分母**：只算覆盖率报告里**有记录**的改动行。改动行落在未纳入统计的文件里
 *      （被 coverage 排除的配置/类型文件）不计入，但会把条数报出来；
 *      若一条有记录的都没有 ⇒ 不判定（0/0 不是 100%）。
 */

/** 覆盖率报告按行记录的命中次数：repo 相对路径 → 行号 → 命中次数 */
export type LineCoverage = Map<string, Map<number, number>>;

/** 改动行集合：repo 相对路径 → 新增/修改的行号 */
export type ChangedLines = Map<string, Set<number>>;

/** 覆盖率报告候选（相对项目根，按顺序取第一个存在的） */
export const DEFAULT_DIFF_COVERAGE_REPORTS: readonly string[] = [
  'coverage/lcov.info',
  'coverage/coverage-final.json',
];

/** diff 覆盖率计算结果 */
export interface DiffCoverageResult {
  /** 覆盖率百分比（保留一位小数） */
  readonly pct: number;
  readonly coveredLines: number;
  readonly totalLines: number;
  /** 落在覆盖率报告之外（未纳入统计）的改动行数 */
  readonly unmeasuredLines: number;
}

/** 基线解析结果 */
export type CoverageBaseResult =
  | { readonly base: string; readonly how: string }
  | { readonly reason: string };

/**
 * 解析覆盖率基线。
 *
 * 顺序：显式指定 → `origin/main` → `origin/master` → `main` → `master`，均取 merge-base。
 * 只认「能 merge-base 成功」的 ref：拿 HEAD~10 当基线会把别人的提交算成自己的改动。
 */
export function resolveCoverageBase(repoRoot: string, explicit?: string): CoverageBaseResult {
  if (explicit) {
    const verified = tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${explicit}^{commit}`]);
    if (verified === undefined) {
      return { reason: `指定的覆盖率基线「${explicit}」在仓库中不存在，无法计算 diff 覆盖率` };
    }
    return { base: explicit, how: '显式指定' };
  }
  const tried: string[] = [];
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    tried.push(ref);
    const mergeBase = tryGit(repoRoot, ['merge-base', 'HEAD', ref]);
    if (mergeBase) return { base: mergeBase.trim(), how: `与 ${ref} 的 merge-base` };
  }
  return {
    reason:
      `无法确定 diff 覆盖率基线（尝试过 ${tried.join(' / ')}，均无法 merge-base）。` +
      '该门禁声明 scope=diff，必须有可比基线才能只统计改动行；' +
      '可用 ZH_COVERAGE_BASE 显式指定（如某个 tag 或基准分支）',
  };
}

/** 取 base..工作区 的改动行 */
export function readChangedLines(repoRoot: string, base: string): ChangedLines | string {
  const patch = tryGit(repoRoot, ['diff', '--unified=0', '--no-color', '--no-ext-diff', base, '--']);
  if (patch === undefined) {
    return `读取改动行失败：git diff ${base} 执行失败（仓库可能不可用或该 commit 已被回收）`;
  }
  return parseUnifiedDiffHunks(patch);
}

/** 解析 `git diff --unified=0` 的 `+` 侧行号（只认 hunk 头，不解析内容） */
export function parseUnifiedDiffHunks(patch: string): ChangedLines {
  const result: ChangedLines = new Map();
  let current: Set<number> | undefined;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      const file = line.slice(4).trim();
      current = file === '/dev/null' ? undefined : mapFileOf(file, result);
      continue;
    }
    if (!line.startsWith('@@')) continue;
    if (!current) continue;
    const added = readAddedSpan(line);
    if (!added) continue;
    for (let n = added.start; n < added.start + added.count; n += 1) current.add(n);
  }
  return result;
}

/** `@@ -a,b +c,d @@` → `+c,d`；缺省 count 视为 1 */
function readAddedSpan(hunkHeader: string): { start: number; count: number } | undefined {
  const plus = hunkHeader.split('+')[1];
  if (!plus) return undefined;
  const [startRaw, countRaw] = plus.split(' ')[0].split(',');
  const start = Number(startRaw);
  const count = countRaw === undefined ? 1 : Number(countRaw);
  if (!Number.isFinite(start) || !Number.isFinite(count)) return undefined;
  return { start, count };
}

/** git 输出路径的 `b/` 前缀。提在模块作用域：函数内字面量每次调用都会重新编译正则 */
const DIFF_B_PREFIX_RE = /^b\//;

/** git 输出 `b/src/a.ts`；`/dev/null` 由调用方处理 */
function mapFileOf(rawPath: string, into: ChangedLines): Set<number> {
  const normalized = rawPath.replace(DIFF_B_PREFIX_RE, '');
  let set = into.get(normalized);
  if (!set) {
    set = new Set<number>();
    into.set(normalized, set);
  }
  return set;
}

/**
 * 计算 diff 覆盖率。
 *
 * @param changed   改动行（repo 相对路径）
 * @param coverage  覆盖率报告（同一相对路径口径）
 * @returns 有记录行为 0 时返回原因字符串 —— 0/0 不当作 100%
 */
export function computeDiffCoverage(
  changed: ChangedLines,
  coverage: LineCoverage,
): DiffCoverageResult | { readonly reason: string } {
  let covered = 0;
  let total = 0;
  let unmeasured = 0;
  for (const [file, lines] of changed) {
    const fileHits = coverage.get(file);
    for (const line of lines) {
      const hits = fileHits?.get(line);
      if (hits === undefined) {
        unmeasured += 1;
        continue;
      }
      total += 1;
      if (hits > 0) covered += 1;
    }
  }
  if (total === 0) {
    return {
      reason:
        `本次改动的 ${unmeasured} 行全部落在覆盖率统计范围之外` +
        '（改动文件未出现在覆盖率报告里，常见于被 coverage 配置排除的文件），无法计算 diff 覆盖率',
    };
  }
  return {
    pct: Math.round((covered / total) * 1000) / 10,
    coveredLines: covered,
    totalLines: total,
    unmeasuredLines: unmeasured,
  };
}

/** 读取覆盖率报告的行级数据；都没有返回 undefined */
export function readLineCoverage(
  repoRoot: string,
  candidates: readonly string[] = DEFAULT_DIFF_COVERAGE_REPORTS,
): LineCoverage | undefined {
  for (const rel of candidates) {
    const full = path.resolve(repoRoot, rel);
    let raw: string;
    try {
      raw = fs.readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    const parsed = rel.endsWith('.json')
      ? parseCoverageFinal(raw, repoRoot)
      : parseLcov(raw, repoRoot);
    if (parsed.size > 0) return parsed;
  }
  return undefined;
}

/**
 * 解析 lcov.info。
 *
 * `SF:` 是文件绝对路径（各覆盖率工具一致）；`DA:<line>,<hits>` 为行命中。
 * 没有 `DA` 记录的文件（如仅有函数级数据）不参与行覆盖率计算。
 */
export function parseLcov(text: string, repoRoot: string): LineCoverage {
  const result: LineCoverage = new Map();
  let current: Map<number, number> | undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('SF:')) {
      const relative = toRepoRelative(trimmed.slice(3).trim(), repoRoot);
      current = new Map<number, number>();
      result.set(relative, current);
      continue;
    }
    if (!trimmed.startsWith('DA:')) continue;
    if (!current) continue;
    const [lineRaw, hitsRaw] = trimmed.slice(3).split(',');
    const lineNo = Number(lineRaw);
    const hits = Number(hitsRaw);
    if (!Number.isFinite(lineNo) || !Number.isFinite(hits)) continue;
    current.set(lineNo, hits);
  }
  return result;
}

/**
 * 解析 istanbul `coverage-final.json`。
 *
 * 优先用 `l`（行命中表）；缺失时由 `statementMap` + `s` 反推行命中（任一语句命中即算覆盖）。
 * vitest 默认 reporter 不含 lcov 但会产出 coverage-final.json，故这条分支是主路径。
 */
export function parseCoverageFinal(raw: string, repoRoot: string): LineCoverage {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new Map();
  }
  const result: LineCoverage = new Map();
  for (const [file, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== 'object') continue;
    const lines = readFileLines(entry as Record<string, unknown>);
    if (lines.size > 0) result.set(toRepoRelative(file, repoRoot), lines);
  }
  return result;
}

function readFileLines(entry: Record<string, unknown>): Map<number, number> {
  const hits = entry.l;
  if (hits && typeof hits === 'object') {
    const map = new Map<number, number>();
    for (const [lineRaw, countRaw] of Object.entries(hits as Record<string, unknown>)) {
      const lineNo = Number(lineRaw);
      const count = Number(countRaw);
      if (Number.isFinite(lineNo) && Number.isFinite(count)) map.set(lineNo, count);
    }
    if (map.size > 0) return map;
  }
  return deriveFromStatements(entry);
}

function deriveFromStatements(entry: Record<string, unknown>): Map<number, number> {
  const statementMap = entry.statementMap;
  const counts = entry.s;
  const map = new Map<number, number>();
  if (!statementMap || typeof statementMap !== 'object' || !counts || typeof counts !== 'object') {
    return map;
  }
  for (const [id, span] of Object.entries(statementMap as Record<string, unknown>)) {
    const count = Number((counts as Record<string, unknown>)[id]);
    if (!Number.isFinite(count)) continue;
    const start = readSpanLine(span, 'start');
    const end = readSpanLine(span, 'end');
    if (start === undefined || end === undefined) continue;
    for (let line = start; line <= end; line += 1) {
      const prev = map.get(line) ?? 0;
      map.set(line, Math.max(prev, count));
    }
  }
  return map;
}

function readSpanLine(span: unknown, edge: 'start' | 'end'): number | undefined {
  if (!span || typeof span !== 'object') return undefined;
  const value = (span as Record<string, unknown>)[edge];
  if (!value || typeof value !== 'object') return undefined;
  const line = Number((value as Record<string, unknown>).line);
  return Number.isFinite(line) ? line : undefined;
}

/** 绝对路径 → repo 相对路径（posix 分隔符）；已是相对路径原样保留 */
export function toRepoRelative(file: string, repoRoot: string): string {
  const normalized = path.isAbsolute(file) ? path.relative(repoRoot, file) : file;
  return normalized.split(path.sep).join('/');
}

/** git 执行失败（非零退出 / 无 git）一律返回 undefined，由调用方给原因 */
function tryGit(repoRoot: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}
