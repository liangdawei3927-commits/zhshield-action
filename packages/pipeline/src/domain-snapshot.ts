/**
 * 域快照 schema 与只读消费入口（《07》A6 / O8）。
 *
 * 各治理域把结果写到 `<project>/.zhshield/diagnostics/domains/<source>.json`，
 * 门禁等下游域只读这些快照、不重跑工具（C3）。schema 与读取器放在 pipeline
 * （编排层）而不是 desktop：CLI / 桌面端 / 未来其它前端必须共用同一份口径，
 * 否则「谁能读域快照」会散落成多套实现，落盘格式一改就漂移。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DomainConclusionSet } from '@zh/shared';

// ─── 诊断条目（归一化，跨 guard/inspect/refactor） ─────────────────────

/** 归一化诊断严重级别：error / warning / info */
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** 归一化诊断条目：跨 guard/inspect/refactor 等引擎统一的问题描述（落盘进 latest.json） */
export interface DiagnosticEntry {
  /** 规则 ID（guard 为 checkId，refactor 为 smell 规则） */
  ruleId: string;
  severity: DiagnosticSeverity;
  category: string;
  message: string;
  /** 相对项目根的文件路径；无位置信息的条目为空字符串 */
  file: string;
  /** 1-based 行号 */
  line?: number;
  /** 1-based 列号 */
  column?: number;
  suggestion?: string;
  autoFixable: boolean;
  /**
   * 来源引擎，同时是按域快照的落盘键（`domains/<source>.json`）。
   * **不得借用别域的 source**：按 source 分桶落盘时，借用他域键等于用本域数据抹掉他域快照。
   */
  source: 'guard' | 'inspect' | 'refactor' | 'deps' | 'techdebt' | 'security' | 'performance';
  /** 去重指纹 */
  fingerprint: string;
  /**
   * 工具执行失败标记（规则评估 status=error 且无 violation 明细，如外部工具崩溃/
   * 配置缺失）。**不是项目的代码问题**：UI 与详情列表照常展示（信息不丢），
   * 但评分链路与门禁判定必须豁免 —— 否则「工具坏了」会以 warning 档污染业务结论。
   */
  toolError?: boolean;
}

// ─── LSP 风格按文件视图（模拟 publishDiagnostics） ─────────────────────

/** LSP 风格诊断项（模拟 publishDiagnostics 载荷，行列均为 0-based） */
export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** 1=error, 2=warning, 3=info */
  severity: 1 | 2 | 3;
  code: string;
  source: 'zhshield';
  message: string;
  data: {
    category: string;
    autoFixable: boolean;
    suggestion?: string;
  };
}

/** 按文件聚合的诊断视图：文件 URI + 该文件的 LSP 诊断项 */
export interface FileDiagnostics {
  uri: string;
  diagnostics: readonly LspDiagnostic[];
}

// ─── 落盘报告 ─────────────────────────────────────────────────────────

/**
 * 按域快照附带的实时维度评分（落盘时由 @zh/scoring 统一计算，渲染层只读不算）。
 * version = 评分算法版本（scoreVersion 2 起）；跨版本快照的 previousScore 不参与对比。
 */
export interface DomainDimensionScore {
  /** 对应 @zh/scoring 的评分维度 */
  dimension:
    'quality' | 'security' | 'dependencies' | 'performance' | 'garbage' | 'techdebt' | 'refactor';
  /** 0-100（error -8 / warning -4 / info -1，下限 0） */
  score: number;
  /** 计分所依据的问题条数 */
  issues: number;
  status: 'scored' | 'not-run';
  /** 评分算法版本（v1 旧快照缺省） */
  version?: number;
}

/** 落盘的诊断报告（.zhshield/diagnostics/latest.json）：问题汇总 + 条目 + 按文件视图 */
export interface DiagnosticsReport {
  version: '1.0';
  project: { path: string; name: string };
  generatedAt: string;
  summary: { total: number; error: number; warning: number; info: number };
  issues: readonly DiagnosticEntry[];
  files: readonly FileDiagnostics[];
  /** 实时维度评分（仅 inspect 快照携带；旧快照缺省，向后兼容） */
  dimensionScore?: DomainDimensionScore;
  /** 上一次检查的维度分（覆盖写前从旧快照抢救出来的，供「上次 → 本次」对比；仅 inspect） */
  previousScore?: { score: number; generatedAt: string };
  /** 项目 ESLOC（S2 密度归一化分母；仅 inspect 快照携带，供报告中心汇总同口径复用） */
  esloc?: number;
}

/** 诊断条目的来源引擎标识 */
export type DiagnosticSource = DiagnosticEntry['source'];

// ─── 读取 ─────────────────────────────────────────────────────────────

/**
 * 按域快照目录：`<project>/.zhshield/diagnostics/domains/`。
 */
export function domainSnapshotPath(projectPath: string, source: DiagnosticSource): string {
  return join(projectPath, '.zhshield', 'diagnostics', 'domains', `${source}.json`);
}

/** 最小结构校验：快照必须带 version/project/issues 数组（latest.json 等消费方同样复用） */
export function isDiagnosticsReport(value: unknown): value is DiagnosticsReport {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DiagnosticsReport>;
  return (
    typeof candidate.version === 'string' &&
    typeof candidate.project === 'object' &&
    candidate.project !== null &&
    Array.isArray(candidate.issues)
  );
}

/**
 * 读取单份诊断报告文件（解析 + 结构校验，失败返回 null）。
 *
 * `latest.json` 等非按域文件同样走这里，避免每个消费方各写一份
 * `JSON.parse + 校验 + catch` 的重复实现。
 */
export async function readDiagnosticsFile(absPath: string): Promise<DiagnosticsReport | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(absPath, 'utf-8'));
    return isDiagnosticsReport(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 读取某治理域最近一次落盘快照（跨域**只读**消费入口）。
 *
 * 文件不存在 / JSON 损坏 / 结构不符 → null（调用方据此判定「该域本次未运行」，
 * 不得当成「0 个问题」）。
 */
export async function readDomainSnapshot(
  projectPath: string,
  source: DiagnosticSource,
): Promise<DiagnosticsReport | null> {
  return await readDiagnosticsFile(domainSnapshotPath(projectPath, source));
}

/**
 * 门禁纯判定（《07》O8/C3）的结论来源：门禁只读这三域的既有快照，不自行扫描。
 */
const GUARD_CONCLUSION_SOURCES = ['inspect', 'security', 'deps'] as const;

/**
 * 读取各域最近一次落盘快照，装配为门禁的只读结论集。
 *
 * 必须**始终**返回对象（无快照时为空对象）：门禁以「是否注入结论集」区分纯判定
 * 与历史工具派发模式，传 undefined 会让门禁重新去跑 eslint/gitleaks/trivy。
 * 缺某域快照（该域本次未运行）→ 门禁对相关规则记 skipped，不判通过（C4）。
 */
export async function loadGuardConclusions(projectPath: string): Promise<DomainConclusionSet> {
  const set: DomainConclusionSet = {};
  for (const source of GUARD_CONCLUSION_SOURCES) {
    const snapshot = await readDomainSnapshot(projectPath, source);
    if (!snapshot) continue;
    set[source] = {
      domain: source,
      generatedAt: snapshot.generatedAt,
      issues: snapshot.issues.map((issue) => ({
        ruleId: issue.ruleId,
        severity: issue.severity,
        file: issue.file,
        ...(issue.line !== undefined ? { line: issue.line } : {}),
        ...(issue.column !== undefined ? { column: issue.column } : {}),
        message: issue.message,
        ...(issue.suggestion !== undefined ? { suggestion: issue.suggestion } : {}),
        ...(issue.toolError ? { toolError: true } : {}),
      })),
    };
  }
  return set;
}
