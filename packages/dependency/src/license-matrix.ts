/**
 * 许可证矩阵（license-matrix.ts）
 *
 * 对图谱中每个依赖节点的许可证做大小写不敏感的 SPDX 归一化与分类，
 * 输出商用许可合规所需的许可证矩阵（按类别统计 + 风险分级），
 * 对齐《SOP标准规则资料汇总》§8 许可证合规标准（ORT / SPDX）。
 */
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import type { DependencyGraph, DependencyNode } from './types';
import { ROOT_NODE_NAME } from './types';

// ────────────────────────────── 模块级正则常量（避免每次调用重编译） ──────────────────────────────
/** OR 许可证表达式检测（不区分大小写） */
const OR_EXPR_RE = /\s+OR\s+/i;

/** 许可证分类：宽松 / 弱左版 / 强左版 / 未知 */
export type LicenseCategory = 'permissive' | 'weak-copyleft' | 'strong-copyleft' | 'unknown';

/** 合规风险等级 */
export type LicenseRisk = 'low' | 'medium' | 'high';

/** 许可证矩阵单条记录 */
export interface LicenseEntry {
  name: string;
  version: string;
  /** 原始许可证声明（缺失时为 ''） */
  license: string;
  category: LicenseCategory;
  risk: LicenseRisk;
  /** 补充说明（如 unknown 的处置建议） */
  reason?: string;
}

/** 许可证矩阵报告 */
export interface LicenseMatrixReport {
  total: number;
  byCategory: Record<LicenseCategory, number>;
  entries: LicenseEntry[];
}

/** 宽松许可（商用安全，风险低） */
const PERMISSIVE_LICENSES = new Set<string>([
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD',
  'Unlicense', 'MIT-0', 'PostgreSQL', 'Python-2.0', 'Zlib',
]);

/** 弱左版许可（商用需注意衍生条款，风险中） */
const WEAK_COPYLEFT_LICENSES = new Set<string>([
  'LGPL-2.1', 'LGPL-3.0', 'MPL-2.0', 'EPL-2.0', 'CDDL-1.0',
]);

/** 强左版许可（传染性强，商用风险高） */
const STRONG_COPYLEFT_LICENSES = new Set<string>([
  'GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'SSPL-1.0',
]);

/** 许可类别 → 风险等级 */
const RISK_BY_CATEGORY: Record<LicenseCategory, LicenseRisk> = {
  permissive: 'low',
  'weak-copyleft': 'medium',
  'strong-copyleft': 'high',
  unknown: 'medium',
};

/** 归一化键（小写）→ 规范 SPDX id 的别名表 */
const LICENSE_ALIASES: Record<string, string> = {
  mit: 'MIT',
  'apache-2.0': 'Apache-2.0',
  'apache-2': 'Apache-2.0',
  'apache 2.0': 'Apache-2.0',
  'apache2': 'Apache-2.0',
  'apache license 2.0': 'Apache-2.0',
  'apache license, version 2.0': 'Apache-2.0',
  'apache-2.0 license': 'Apache-2.0',
  'bsd-2-clause': 'BSD-2-Clause',
  'bsd 2-clause': 'BSD-2-Clause',
  'bsd 2 clause': 'BSD-2-Clause',
  'bsd-3-clause': 'BSD-3-Clause',
  'bsd 3-clause': 'BSD-3-Clause',
  'bsd 3 clause': 'BSD-3-Clause',
  bsd: 'BSD-3-Clause',
  'new bsd': 'BSD-3-Clause',
  isc: 'ISC',
  '0bsd': '0BSD',
  unlicense: 'Unlicense',
  'the unlicense': 'Unlicense',
  'mit-0': 'MIT-0',
  postgresql: 'PostgreSQL',
  'python-2.0': 'Python-2.0',
  zlib: 'Zlib',
  'lgpl-2.1': 'LGPL-2.1',
  'lgpl 2.1': 'LGPL-2.1',
  'lgpl-2.1-only': 'LGPL-2.1',
  'lgpl-2.1-or-later': 'LGPL-2.1',
  lgplv2: 'LGPL-2.1',
  'lgpl-3.0': 'LGPL-3.0',
  'lgpl 3.0': 'LGPL-3.0',
  'lgpl-3': 'LGPL-3.0',
  'lgpl-3.0-only': 'LGPL-3.0',
  'lgpl-3.0-or-later': 'LGPL-3.0',
  lgplv3: 'LGPL-3.0',
  'mpl-2.0': 'MPL-2.0',
  'mpl 2.0': 'MPL-2.0',
  'mozilla public license 2.0': 'MPL-2.0',
  'mozilla public license version 2.0': 'MPL-2.0',
  'epl-2.0': 'EPL-2.0',
  'epl 2.0': 'EPL-2.0',
  'eclipse public license 2.0': 'EPL-2.0',
  'cddl-1.0': 'CDDL-1.0',
  'cddl 1.0': 'CDDL-1.0',
  'common development and distribution license 1.0': 'CDDL-1.0',
  'gpl-2.0': 'GPL-2.0',
  'gpl 2.0': 'GPL-2.0',
  gpl2: 'GPL-2.0',
  gplv2: 'GPL-2.0',
  'gpl-2.0-only': 'GPL-2.0',
  'gpl-2.0-or-later': 'GPL-2.0',
  'gnu general public license v2.0': 'GPL-2.0',
  'gnu general public license 2.0': 'GPL-2.0',
  'gpl-3.0': 'GPL-3.0',
  'gpl 3.0': 'GPL-3.0',
  gpl3: 'GPL-3.0',
  gplv3: 'GPL-3.0',
  'gpl-3.0-only': 'GPL-3.0',
  'gpl-3.0-or-later': 'GPL-3.0',
  'gnu general public license v3.0': 'GPL-3.0',
  'gnu general public license 3.0': 'GPL-3.0',
  'agpl-3.0': 'AGPL-3.0',
  'agpl 3.0': 'AGPL-3.0',
  agpl3: 'AGPL-3.0',
  agplv3: 'AGPL-3.0',
  'agpl-3.0-only': 'AGPL-3.0',
  'agpl-3.0-or-later': 'AGPL-3.0',
  'gnu affero general public license v3.0': 'AGPL-3.0',
  'sspl-1.0': 'SSPL-1.0',
  'sspl 1.0': 'SSPL-1.0',
  'server side public license v1': 'SSPL-1.0',
};

/**
 * 限制程度排名（用于 OR 表达式选择更严格的许可）。
 * 强左版 > 弱左版 > Apache-2.0 > 其余宽松 > 未知。
 */
function restrictionRank(id: string): number {
  if (STRONG_COPYLEFT_LICENSES.has(id)) return 5;
  if (WEAK_COPYLEFT_LICENSES.has(id)) return 4;
  if (id === 'Apache-2.0') return 3;
  if (PERMISSIVE_LICENSES.has(id)) return 2;
  return 1;
}

/**
 * 将许可证声明归一化为规范 SPDX id。
 *
 * 处理：
 * - 大小写不敏感、空格/连字符归一（'Apache 2.0' / 'Apache-2' / 'apache2' → 'Apache-2.0'）
 * - 外围括号剥离（'(MIT)' → 'MIT'）
 * - OR 表达式取更严格者（'MIT OR Apache-2.0' → 'Apache-2.0'）
 * 无法识别时返回 null。
 */
export function normalizeLicenseId(license: string): string | null {
  let raw = license.trim();
  if (raw === '') return null;
  raw = stripOuterParens(raw);
  if (OR_EXPR_RE.test(raw)) return resolveOrExpression(raw);
  const key = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  return LICENSE_ALIASES[key] ?? null;
}

/** 剥离外围括号（可能多层，如 '((MIT))'） */
function stripOuterParens(raw: string): string {
  let result = raw;
  while (result.startsWith('(') && result.endsWith(')')) {
    result = result.slice(1, -1).trim();
  }
  return result;
}

/** OR 表达式：逐项归一化后取更严格者 */
function resolveOrExpression(raw: string): string | null {
  const candidates = raw
    .split(OR_EXPR_RE)
    .map((part) => normalizeLicenseId(part))
    .filter((id): id is string => id !== null);
  if (candidates.length === 0) return null;
  const sorted = candidates.toSorted((a, b) => restrictionRank(b) - restrictionRank(a));
  return sorted[0] ?? null;
}

/**
 * 将许可证声明归类为 permissive / weak-copyleft / strong-copyleft / unknown。
 * 缺失或无法识别的许可一律归为 unknown（需人工确认）。
 */
export function classifyLicense(license: string | undefined): LicenseCategory {
  const id = license ? normalizeLicenseId(license) : null;
  if (!id) return 'unknown';
  if (STRONG_COPYLEFT_LICENSES.has(id)) return 'strong-copyleft';
  if (WEAK_COPYLEFT_LICENSES.has(id)) return 'weak-copyleft';
  if (PERMISSIVE_LICENSES.has(id)) return 'permissive';
  return 'unknown';
}

/**
 * 构建许可证矩阵：遍历图谱中每个依赖节点（根节点除外），
 * 归一化分类许可证并附风险等级，同时输出按类别计数。
 */
export function buildLicenseMatrix(graph: DependencyGraph, locale?: LanguageCode): LicenseMatrixReport {
  const entries: LicenseEntry[] = [];

  const nodes: DependencyNode[] = graph.nodes.filter((node) => node.name !== ROOT_NODE_NAME);
  for (const node of nodes) {
    const license = node.license ?? '';
    const category = classifyLicense(license);
    const entry: LicenseEntry = {
      name: node.name,
      version: node.version,
      license,
      category,
      risk: RISK_BY_CATEGORY[category],
    };
    if (category === 'unknown') {
      entry.reason = translate('engine.dependency.license.unknownReason', locale ?? DEFAULT_LANGUAGE);
    }
    entries.push(entry);
  }

  const byCategory: Record<LicenseCategory, number> = {
    permissive: 0,
    'weak-copyleft': 0,
    'strong-copyleft': 0,
    unknown: 0,
  };
  for (const entry of entries) {
    byCategory[entry.category] += 1;
  }

  return { total: entries.length, byCategory, entries };
}
