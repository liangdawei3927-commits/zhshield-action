import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { WhitelistManager } from '@zh/guard';
import { buildHealthDimensions, SCORE_VERSION } from '@zh/scoring';
import type { PipelineReport } from '@zh/pipeline';
import type { DiagnosticEntry, DiagnosticSource, DiagnosticsReport } from './zh-diagnostics-types';
import { buildDiagnosticsReport, countSourceEsloc } from './zh-diagnostics-esloc';
import { normalizePipelineReport } from './zh-diagnostics-normalize';

// ─── 落盘 ──────────────────────────────────────────────────────────────

// 串行化写入队列：并发扫描（guard/inspect/refactor/performance 可并行触发）时
// 保证 latest.json 的写入互不交错，始终以最后一次写入为准。
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * 按域快照目录：`<project>/.zhshield/diagnostics/domains/`。
 */
export function domainSnapshotPath(projectPath: string, source: DiagnosticSource): string {
  return join(projectPath, '.zhshield', 'diagnostics', 'domains', `${source}.json`);
}

/** 按域拆分快照条目：跑过的域先占位（空数组），未跑过的域保留旧快照 */
function buildPerSourceEntries(
  report: DiagnosticsReport,
  ranSources: readonly DiagnosticSource[],
): Map<DiagnosticSource, DiagnosticEntry[]> {
  const perSource = new Map<DiagnosticSource, DiagnosticEntry[]>();
  for (const source of ranSources) perSource.set(source, []);
  for (const entry of report.issues) {
    const bucket = perSource.get(entry.source);
    if (bucket) bucket.push(entry);
    else perSource.set(entry.source, [entry]);
  }
  return perSource;
}

/** 写入 latest.json 与各域快照（各域快照彼此独立 → 并行写，不做串行 await） */
async function writeDomainSnapshots(
  report: DiagnosticsReport,
  perSource: Map<DiagnosticSource, DiagnosticEntry[]>,
): Promise<void> {
  if (perSource.size === 0) return;
  await mkdir(join(report.project.path, '.zhshield', 'diagnostics', 'domains'), {
    recursive: true,
  });
  const writes: Promise<void>[] = [];
  const esloc = perSource.has('inspect') ? await countSourceEsloc(report.project.path) : 0;
  for (const [source, issues] of perSource) {
    const snapshot = await buildDomainSnapshot(report, source, issues, esloc);
    writes.push(
      writeFile(
        domainSnapshotPath(report.project.path, source),
        `${JSON.stringify(snapshot, null, 2)}\n`,
        'utf-8',
      ),
    );
  }
  await Promise.all(writes);
}

async function buildDomainSnapshot(
  report: DiagnosticsReport,
  source: DiagnosticSource,
  issues: readonly DiagnosticEntry[],
  esloc: number,
): Promise<DiagnosticsReport> {
  const snapshot = buildDiagnosticsReport(report.project, issues, report.generatedAt);
  if (source !== 'inspect') return snapshot;
  await enrichInspectSnapshot(report, snapshot, esloc);
  return snapshot;
}

/** 巡检快照当场出分（quality 维，S1+S2：同规则聚合封顶 + ESLOC 密度归一化）并抢救上一轮分数 */
async function enrichInspectSnapshot(
  report: DiagnosticsReport,
  snapshot: DiagnosticsReport,
  esloc: number,
): Promise<void> {
  const [quality] = buildHealthDimensions({
    guard: null,
    inspect: {
      issues: snapshot.issues.map((e) => ({
        severity: e.severity,
        category: e.category,
        ruleId: e.ruleId,
      })),
      esloc,
    },
  });
  snapshot.esloc = esloc;
  if (quality?.name === 'quality' && quality.status) {
    snapshot.dimensionScore = {
      dimension: 'quality',
      score: quality.score,
      issues: quality.issues,
      status: quality.status,
      version: SCORE_VERSION,
    };
  }
  const previousScore = await rescuePreviousScore(report);
  if (previousScore) snapshot.previousScore = previousScore;
}

/** 「上次 → 本次」对比：从旧快照抢救上一轮 dimensionScore（generatedAt 不同且算法版本一致才带） */
async function rescuePreviousScore(
  report: DiagnosticsReport,
): Promise<{ score: number; generatedAt: string } | undefined> {
  try {
    const oldRaw = await readFile(domainSnapshotPath(report.project.path, 'inspect'), 'utf-8');
    const old = JSON.parse(oldRaw) as {
      generatedAt?: string;
      dimensionScore?: { score: number; version?: number };
    };
    if (
      old.dimensionScore &&
      typeof old.dimensionScore.score === 'number' &&
      old.dimensionScore.version === SCORE_VERSION &&
      old.generatedAt &&
      old.generatedAt !== report.generatedAt
    ) {
      return { score: old.dimensionScore.score, generatedAt: old.generatedAt };
    }
  } catch {
    // 旧快照不存在/损坏 → 无对比基线，静默跳过
  }
  return undefined;
}

/** 写入 <project>/.zhshield/diagnostics/latest.json，返回绝对路径 */
export async function writeDiagnosticsFile(
  report: DiagnosticsReport,
  ranSources: readonly DiagnosticSource[] = [],
): Promise<string> {
  const dir = join(report.project.path, '.zhshield', 'diagnostics');
  const absPath = join(dir, 'latest.json');
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  const perSource = buildPerSourceEntries(report, ranSources);
  // 排队执行，避免并发扫描时多次 writeFile 交错覆盖
  writeQueue = writeQueue
    .then(async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(absPath, payload, 'utf-8');
      await writeDomainSnapshots(report, perSource);
    })
    .catch((err) => {
      // 自愈：单次写入失败只记 warn 复位队列，writeQueue 不永久 reject。
      console.warn(
        '[zh-diagnostics] 诊断文件写入失败（队列已自愈，后续写入可继续）:',
        err instanceof Error ? err.message : String(err),
      );
    });
  await writeQueue;
  return absPath;
}

/**
 * 读取某治理域最近一次落盘快照（跨域**只读**消费入口）。
 */
export async function readDomainSnapshot(
  projectPath: string,
  source: DiagnosticSource,
): Promise<DiagnosticsReport | null> {
  try {
    const raw = await readFile(domainSnapshotPath(projectPath, source), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isDiagnosticsReport(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 最小结构校验：快照必须带 version/project/issues 数组 */
function isDiagnosticsReport(value: unknown): value is DiagnosticsReport {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DiagnosticsReport>;
  return (
    typeof candidate.version === 'string' &&
    typeof candidate.project === 'object' &&
    candidate.project !== null &&
    Array.isArray(candidate.issues)
  );
}

/** 依据 <project>/.zhshield/whitelist.yml 过滤被白名单压制的误报条目（rule+file 精确匹配） */
function filterWhitelisted(
  whitelist: WhitelistManager,
  entries: readonly DiagnosticEntry[],
): readonly DiagnosticEntry[] {
  return entries.filter(
    (entry) => !(entry.file && whitelist.isWhitelisted(entry.ruleId, entry.file).whitelisted),
  );
}

/** pipeline 报告一键归一化并落盘（dryRun 由调用方决定是否跳过） */
export async function persistDiagnostics(
  projectPath: string,
  report: PipelineReport,
): Promise<string> {
  const whitelist = new WhitelistManager(projectPath);
  await whitelist.load();
  const issues = filterWhitelisted(whitelist, normalizePipelineReport(report));
  const diagnostics = buildDiagnosticsReport(
    { path: projectPath, name: basename(projectPath) },
    issues,
    new Date().toISOString(),
  );
  // PipelineReport 的 guard/inspect/refactor 为可选字段：**字段存在 = 该域跑过**。
  const ranSources: DiagnosticSource[] = [];
  if (report.guard) ranSources.push('guard');
  if (report.inspect) ranSources.push('inspect');
  if (report.refactor) ranSources.push('refactor');
  return await writeDiagnosticsFile(diagnostics, ranSources);
}

/**
 * 用已归一化的 entries 直接落盘。
 * 供 runInspect/runGuard/runRefactor/runPerformance 单独扫描时复用，
 * 避免每次单独扫描都走 PipelineReport 形状。
 */
export async function persistDiagnosticsFromEntries(
  projectPath: string,
  entries: readonly DiagnosticEntry[],
  ranSources: readonly DiagnosticSource[],
): Promise<string> {
  const whitelist = new WhitelistManager(projectPath);
  await whitelist.load();
  const diagnostics = buildDiagnosticsReport(
    { path: projectPath, name: basename(projectPath) },
    filterWhitelisted(whitelist, entries),
    new Date().toISOString(),
  );
  return await writeDiagnosticsFile(diagnostics, ranSources);
}
