/**
 * 「最近一次检查结果」视图的数据整形（纯函数，无 React / 无 IO）。
 *
 * 背景（为什么要这个模块）：
 * 分类页右上角的详情入口原本只在本次会话扫出 `report` 时才可点，
 * 而页面上的评分是从磁盘算出来的 —— 于是「有分无按钮」，或退化成
 * 「点详情就替用户重扫一遍」。用户要的是：有分就点得进，进去看到的是
 * **上次检查的真实结果**，不是新一轮扫描。
 *
 * 磁盘上现成的历史产物有两种形态：
 * 1. `.zhshield/diagnostics/domains/<d>.json` —— 归一化诊断（`issues[]`），
 *    评分就是由这批条目算出来的（deps / refactor / security / techdebt / performance / inspect）；
 * 2. 垃圾域的 `<d>.json` —— `items[]` + `checks[]`（清单形态，无 severity）。
 *
 * 本模块只做「有什么就映什么」：字段缺失不补造，条目为空就是空，
 * 绝不引入「通过数 = 0」这类凭空推断。
 */

/** 单条历史问题（跨域统一形状，供视图直接渲染） */
export interface SnapshotEntry {
  /** 稳定 key（fingerprint 优先，缺失则用序号） */
  key: string;
  severity: 'error' | 'warning' | 'info';
  /** 主文案（问题描述 / 垃圾条目原因） */
  title: string;
  /** 位置（`file:line:col` / 垃圾条目路径），无则空串 */
  location: string;
  /** 规则 / 类型标识 */
  ruleId: string;
  /** 修复建议（快照里有才显示） */
  suggestion?: string;
  autoFixable: boolean;
}

/** 视图消费的整形结果 */
export interface SnapshotReport {
  /** 落盘时间（ISO 串原样，视图负责格式化；缺失为 null） */
  generatedAt: string | null;
  total: number;
  error: number;
  warning: number;
  info: number;
  /** 已按严重级排序后的条目（error → warning → info） */
  entries: SnapshotEntry[];
  /** 数据形态：issues=归一化诊断 / items=清单（垃圾域）/ empty=没有可展示条目 */
  shape: 'issues' | 'items' | 'empty';
}

/** 视图最多渲染的条目数（重构域动辄数百条，全量渲染会卡住 8GB 机器） */
export const SNAPSHOT_ENTRY_LIMIT = 100;

const SEVERITY_ORDER: Record<SnapshotEntry['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asSeverity(value: unknown): SnapshotEntry['severity'] {
  return value === 'error' || value === 'warning' || value === 'info' ? value : 'info';
}

/** 拼 `file:line:col`；没有文件路径时返回空串（不显示假的「未知文件」） */
function formatLocation(file: string, line: unknown, column: unknown): string {
  if (!file) return '';
  const parts = [file];
  if (typeof line === 'number' && line > 0) {
    parts.push(String(line));
    if (typeof column === 'number' && column > 0) parts.push(String(column));
  }
  return parts.join(':');
}

/** 归一化诊断形态（`issues[]`）→ 视图条目 */
function fromIssues(raw: Record<string, unknown>): SnapshotEntry[] {
  return asArray(raw.issues).map((item, index) => {
    const issue = isRecord(item) ? item : {};
    return {
      key: asString(issue.fingerprint) || asString(issue.ruleId) || `issue-${index}`,
      severity: asSeverity(issue.severity),
      title: asString(issue.message),
      location: formatLocation(asString(issue.file), issue.line, issue.column),
      ruleId: asString(issue.ruleId),
      suggestion: asString(issue.suggestion) || undefined,
      autoFixable: issue.autoFixable === true,
    };
  });
}

/** 清单形态（垃圾域 `items[]`）→ 视图条目；无 severity 语义，一律按提示展示 */
function fromItems(raw: Record<string, unknown>): SnapshotEntry[] {
  return asArray(raw.items).map((item, index) => {
    const entry = isRecord(item) ? item : {};
    return {
      key: asString(entry.id) || `item-${index}`,
      severity: 'info' as const,
      title: asString(entry.reason) || asString(entry.type),
      location: asString(entry.path),
      ruleId: asString(entry.type),
      autoFixable: false,
    };
  });
}

/**
 * 把落盘快照整形为视图数据；无法识别的形态返回 null（视图据此回退到「无可展示内容」）。
 *
 * 计数优先取快照自带的 `summary`（那份是落盘时算的，与评分同源）；
 * 缺失时按条目实际数量兜底统计，绝不写死 0。
 */
export function toSnapshotReport(raw: unknown): SnapshotReport | null {
  if (!isRecord(raw)) return null;

  const issues = asArray(raw.issues);
  const items = asArray(raw.items);
  const shape: SnapshotReport['shape'] = issues.length > 0 ? 'issues' : items.length > 0 ? 'items' : 'empty';

  const entries = (shape === 'items' ? fromItems(raw) : fromIssues(raw)).sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  const summary = isRecord(raw.summary) ? raw.summary : {};
  const countOf = (key: 'total' | 'error' | 'warning' | 'info', fallback: number): number =>
    typeof summary[key] === 'number' ? (summary[key] as number) : fallback;

  const generatedAt =
    asString(raw.generatedAt) || asString(raw.timestamp) || null;

  return {
    generatedAt,
    total: countOf('total', entries.length),
    error: countOf('error', entries.filter((e) => e.severity === 'error').length),
    warning: countOf('warning', entries.filter((e) => e.severity === 'warning').length),
    info: countOf('info', entries.filter((e) => e.severity === 'info').length),
    entries,
    shape,
  };
}
