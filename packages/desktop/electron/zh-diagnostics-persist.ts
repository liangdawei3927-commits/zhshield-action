import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { WhitelistManager } from '@zh/guard';
import { buildHealthDimensions, SCORE_VERSION } from '@zh/scoring';
import type { PipelineReport } from '@zh/pipeline';
import type { DiagnosticEntry, DiagnosticSource, DiagnosticsReport } from './zh-diagnostics-types';
import { buildDiagnosticsReport, countSourceEsloc } from './zh-diagnostics-esloc';
import { normalizePipelineReport } from './zh-diagnostics-normalize';
import { appendDomainHistory, buildScanRecord } from './domain-history';

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
    writes.push(recordScanHistory({ report, source, issues, snapshot, esloc }));
  }
  await Promise.all(writes);
}

/**
 * 一次域扫描的历史落盘入参。
 *
 * 这五个值同属「本次域扫描的产物」，位置式传参时 `issues`/`snapshot` 两个
 * 同为报告形态的入参极易传反（且都是「报告 + 条目」相关），收敛成对象后
 * 由字段名自解释。
 */
interface ScanHistoryInput {
  /** 本次整体报告（提供项目路径与扫描时间） */
  report: DiagnosticsReport;
  /** 域键 */
  source: DiagnosticSource;
  /** 该域的条目 */
  issues: readonly DiagnosticEntry[];
  /** 该域的单域快照（出分口径以此为准） */
  snapshot: DiagnosticsReport;
  /** inspect 域源码有效行数（其他域无意义） */
  esloc: number;
}

/**
 * 把本次域扫描写进历史（`history/<domain>.jsonl`）。
 *
 * 与快照覆盖写并行：快照只保留「最近一次」，历史保留每一次 —— 这是
 * 「今天为什么掉 5 分」「这条问题是我修的还是它自己消失的」唯一可回溯的依据。
 *
 * 独立性：历史写入失败只 warn，**不得**影响快照落盘（否则为了记历史反而丢了当前结果）。
 */
async function recordScanHistory({
  report,
  source,
  issues,
  snapshot,
  esloc,
}: ScanHistoryInput): Promise<void> {
  try {
    const dimensionScore = snapshot.dimensionScore;
    const record = buildScanRecord({
      domain: source,
      scannedAt: report.generatedAt,
      recordedAt: new Date().toISOString(),
      projectPath: report.project.path,
      issues,
      score: dimensionScore?.score ?? null,
      ...(dimensionScore?.version === undefined
        ? {}
        : { scoreVersion: dimensionScore.version }),
      // esloc 只对 inspect 有意义（其他域没有密度归一化分母），传 0 会被误读成「零行项目」
      ...(source === 'inspect' && esloc > 0 ? { esloc } : {}),
    });
    await appendDomainHistory(report.project.path, record, issues);
  } catch (err) {
    console.warn(
      '[zh-diagnostics] 域历史写入失败（快照已落盘，不影响当前结果）:',
      err instanceof Error ? err.message : String(err),
    );
  }
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
      // toolError（工具执行失败）不是代码问题，不参与 quality 扣分（见 DiagnosticEntry.toolError）
      issues: snapshot.issues
        .filter((e) => e.toolError !== true)
        .map((e) => ({
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
  return await readReportFile(domainSnapshotPath(projectPath, source));
}

/** 读取单份诊断报告文件（解析 + 结构校验，失败返回 null） */
async function readReportFile(absPath: string): Promise<DiagnosticsReport | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(absPath, 'utf-8'));
    return isDiagnosticsReport(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface DomainGroup {
  generatedAt: string;
  issues: DiagnosticEntry[];
}

/** 收集各域快照（文件名为域键）。
 *  读取目标固定为 <项目>/.zhshield/diagnostics/domains 单层目录，不递归、不触达 node_modules。 */
async function collectDomainGroups(
  projectPath: string,
): Promise<Map<DiagnosticSource, DomainGroup>> {
  const groups = new Map<DiagnosticSource, DomainGroup>();
  let files: string[];
  try {
    files = await readdir(join(projectPath, '.zhshield', 'diagnostics', 'domains'));
  } catch {
    // 目录不存在 = 从未按域落盘，交由 latest.json 兜底
    files = [];
  }
  // 各域快照互相独立 → 并行读取（顺序由 sources 决定，与串行版一致）
  const sources = files
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length) as DiagnosticSource);
  const snapshots = await Promise.all(
    sources.map(async (source) => ({
      source,
      snapshot: await readDomainSnapshot(projectPath, source),
    })),
  );
  for (const { source, snapshot } of snapshots) {
    if (!snapshot) continue;
    groups.set(source, { generatedAt: snapshot.generatedAt, issues: [...snapshot.issues] });
  }
  return groups;
}

/** latest.json 仅在比同域快照更新（或该域无快照）时覆盖该域 */
function applyLatestGroups(
  groups: Map<DiagnosticSource, DomainGroup>,
  latest: DiagnosticsReport,
): void {
  const bySource = new Map<DiagnosticSource, DiagnosticEntry[]>();
  for (const entry of latest.issues) {
    const bucket = bySource.get(entry.source);
    if (bucket) bucket.push(entry);
    else bySource.set(entry.source, [entry]);
  }
  for (const [source, issues] of bySource) {
    const existing = groups.get(source);
    if (!existing || latest.generatedAt >= existing.generatedAt) {
      groups.set(source, { generatedAt: latest.generatedAt, issues });
    }
  }
}

/** 合并去重（fingerprint 相同的只保留一条）并组装完整报告 */
function mergeGroups(
  projectPath: string,
  groups: Map<DiagnosticSource, DomainGroup>,
  latest: DiagnosticsReport | null,
): DiagnosticsReport {
  const seen = new Set<string>();
  const issues: DiagnosticEntry[] = [];
  let newest = '';
  for (const group of groups.values()) {
    if (group.generatedAt > newest) newest = group.generatedAt;
    for (const entry of group.issues) {
      const key =
        entry.fingerprint || `${entry.source}:${entry.ruleId}:${entry.file}:${entry.line ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(entry);
    }
  }
  const shell =
    latest ??
    buildDiagnosticsReport(
      { path: projectPath, name: basename(projectPath) },
      issues,
      newest || new Date().toISOString(),
    );
  return { ...shell, generatedAt: newest || shell.generatedAt, issues };
}

/**
 * 聚合读取：latest.json 是「最后写入者覆盖」，单引擎扫描（guard/refactor/…）
 * 会把它整体替换成该引擎的结果，导致跨引擎视图残缺。
 * 域快照（domains/<source>.json）彼此独立、互不覆盖，故按 source 取最新一份合并，
 * 保证调用方始终看到完整的治理结果。
 */
export async function readAggregatedDiagnostics(
  projectPath: string,
): Promise<DiagnosticsReport | null> {
  const [groups, latest] = await Promise.all([
    collectDomainGroups(projectPath),
    readReportFile(join(projectPath, '.zhshield', 'diagnostics', 'latest.json')),
  ]);
  if (latest) applyLatestGroups(groups, latest);
  if (groups.size === 0) return latest;
  return mergeGroups(projectPath, groups, latest);
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

/**
 * P1-6：security 域快照「双路合并写入」。
 *
 * 漏洞扫描（runSecurityHandler）与密钥扫描（runSecretsHandler）都往 security 域
 * 落条目——security 维的扣分同时吃两路（findings + active 密钥），域快照必须
 * 两类都可见，否则 Σ域条数 ≠ 维度 issues（实测报告 2026-10-27：security 0 条
 * 却有 2 个 issues，全靠密钥域代算）。
 *
 * 合并规则：各自**覆盖自己那类**条目、保留另一类——密钥条目 ruleId 以 `secret:`
 * 开头，凭此区分。两路谁后写都不能抹掉对方的发现。
 */
export async function persistSecurityDomainEntries(
  projectPath: string,
  entries: readonly DiagnosticEntry[],
  kind: 'vuln' | 'secret',
): Promise<string> {
  const isSecretEntry = (issue: { ruleId: string }): boolean =>
    issue.ruleId.startsWith('secret:');
  const prev = await readDomainSnapshot(projectPath, 'security');
  // issues 本就是 readonly DiagnosticEntry[]（isDiagnosticsReport 守卫已保证），
  // 展开进数组字面量即得可变数组，无需断言——此前的 as unknown as 是历史残留
  const prevIssues: readonly DiagnosticEntry[] = prev?.issues ?? [];
  const write =
    kind === 'vuln'
      ? // 写漏洞：新漏洞条目全量覆盖 + 保留既有密钥条目
        [...entries, ...prevIssues.filter(isSecretEntry)]
      : // 写密钥：新密钥条目全量覆盖（含 0 条=全部已处理）+ 保留既有漏洞条目
        [...prevIssues.filter((e) => !isSecretEntry(e)), ...entries];
  return await persistDiagnosticsFromEntries(projectPath, write, ['security']);
}
