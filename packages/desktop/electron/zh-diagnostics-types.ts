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
   * **不得借用别域的 source**：`buildPerSourceEntries` 按本字段分桶，
   * `writeDomainSnapshots` 对每桶整份覆盖写 —— 借用他域键等于用本域数据抹掉他域快照。
   */
  source: 'guard' | 'inspect' | 'refactor' | 'deps' | 'techdebt' | 'security' | 'performance';
  /** 去重指纹 */
  fingerprint: string;
  /**
   * 工具执行失败标记（规则评估 status=error 且无 violation 明细，如外部工具崩溃/
   * 配置缺失）。**不是项目的代码问题**：UI 与详情列表照常展示（信息不丢），
   * 但评分链路必须豁免 —— 否则「工具坏了」以 warning 档（-4/条）污染业务分数，
   * 与 CLI 侧 degraded 护栏（exit 2）语义不一致（2026-10-26 实测打包版 4 条
   * 工具报错吃掉 16 分 × 密度稀释 ≈ 3.1 分）。
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
 * 目前仅 inspect → quality（巡检与 quality 维的扣分口径一一对应）；
 * gate 维需 status/blocking 语义（快照条目不带），暂不实时评分。
 * version = 评分算法版本（scoreVersion 2 起）；跨版本快照的 previousScore 不参与对比。
 */
export interface DomainDimensionScore {
  /** 对应 @zh/scoring 的评分维度 */
  dimension: 'quality';
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

