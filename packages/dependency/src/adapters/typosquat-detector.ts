/**
 * 投毒检测适配器（typosquat-detector.ts）
 *
 * 离线静态检测依赖投毒（typosquatting）：将图谱中的包名与知名包清单做
 * 编辑距离 + 视觉混淆比对，输出可疑包及其可解释证据（附 B.3 ① / B.6）。
 *
 * 零网络约束：不查询 registry、不获取发布者信誉 / 下载量 / 发布时间，
 * 只填充静态可判信号（nameSimilarity / behaviorFlags）；publisherReputation、
 * downloadAnomaly、publishTiming 需在线数据源，本离线实现一律不填充。
 *
 * 失败语义：信息不足的节点直接跳过，绝不抛异常。
 */
import type { DependencyGraph, DependencyNode } from '../types';

// ────────────────────────────── 模块级正则常量（避免每次调用重编译） ──────────────────────────────
/** 数字检测 */
const CONTAINS_DIGIT_RE = /\d/;

/** 知名包名安全字符集（target 来自常量清单，仍按不可信输入校验） */
const SAFE_TARGET_RE = /^[a-z0-9._-]{1,64}$/i;

/** 转义正则特殊字符（target 为常量清单项，转义后作为字面量匹配） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ────────────────────────────── 公开接口（附 B.3 ①） ──────────────────────────────

/** 投毒检测器：输入依赖图谱 → 输出可疑包列表（含可解释证据） */
export interface TyposquatDetector {
  /** 检测图谱中的 typosquatting 候选 */
  detect(graph: DependencyGraph): Promise<TyposquatFinding[]>;
}

/** 单个可疑包：风险等级 + 信号 + 判定证据 */
export interface TyposquatFinding {
  /** 对应图谱节点 id（'name@version'） */
  nodeId: string;
  /** 风险等级：high / medium / low */
  risk: 'high' | 'medium' | 'low';
  /** 命中信号（仅填充离线可静态判定的部分） */
  signals: TyposquatSignals;
  /** 判定依据（UI 可展开，可解释要求 06 §6.3） */
  evidence: string[];
}

/** 投毒信号集合：全部可选，离线场景仅静态可判项被填充 */
export interface TyposquatSignals {
  /** 与知名包名的相似度（编辑距离 / 视觉混淆） */
  nameSimilarity?: { target: string; score: number };
  /** 发布者信誉（需在线数据源，离线不填充） */
  publisherReputation?: 'verified' | 'new' | 'unknown';
  /** 下载量异常（需在线数据源，离线不填充） */
  downloadAnomaly?: { expected: number; actual: number };
  /** 发布时间（需在线数据源，离线不填充） */
  publishTiming?: { ageDays: number };
  /** 行为标记：名称中的数字 / 连字符等异常（静态可判） */
  behaviorFlags?: string[];
}

// ────────────────────────────── 阈值命名常量 ──────────────────────────────

/** 编辑距离 ≤ 1 → 高危（与知名包仅差一个字符） */
export const HIGH_RISK_MAX_EDIT_DISTANCE = 1;
/** 编辑距离 ≤ 2 → 中危 */
export const MEDIUM_RISK_MAX_EDIT_DISTANCE = 2;
/** 编辑距离 ≤ 3 → 低危（要求目标为常见知名包） */
export const LOW_RISK_MAX_EDIT_DISTANCE = 3;
/** 低危判定要求目标包名最小长度（过短的包名碰瓷噪音大） */
export const LOW_RISK_MIN_TARGET_LENGTH = 4;

// ────────────────────────────── 知名包清单（离线静态字典） ──────────────────────────────

/** 知名 npm 包（typosquatting 高频碰瓷目标） */
const KNOWN_NPM_PACKAGES: readonly string[] = [
  'lodash',
  'express',
  'react',
  'axios',
  'moment',
  'chalk',
  'debug',
  'commander',
  'jsonwebtoken',
  'typescript',
  'webpack',
  'eslint',
  'jest',
  'tslib',
  'rxjs',
  'async',
  'request',
  'ws',
  'uuid',
  'js-toolbox',
];

/** 知名 Python 包（typosquatting 高频碰瓷目标） */
const KNOWN_PYTHON_PACKAGES: readonly string[] = [
  'requests',
  'flask',
  'django',
  'numpy',
  'pandas',
  'click',
  'urllib3',
  'boto3',
  'setuptools',
  'pytest',
];

/** 全部知名包清单（npm + python），供编辑距离 / 视觉混淆比对 */
export const KNOWN_PACKAGES: readonly string[] = [...KNOWN_NPM_PACKAGES, ...KNOWN_PYTHON_PACKAGES];

/** 常见（高频被碰瓷）目标集：低危判定用；长度过短的包名不视为常见目标 */
export const COMMON_TARGETS: ReadonlySet<string> = new Set(
  KNOWN_PACKAGES.filter((name) => name.length >= LOW_RISK_MIN_TARGET_LENGTH),
);

// ────────────────────────────── 编辑距离 ──────────────────────────────

/**
 * 计算两个字符串的编辑距离（Damerau-Levenshtein OSA 变体）。
 *
 * 在 Levenshtein（增 / 删 / 改）基础上额外把「相邻字符交换」计为 1 次编辑：
 * typosquat 常以交换相邻字符制造近似名（如 'lodahs' ↔ 'lodash'），
 * 纯 Levenshtein 会把此类交换计为 2，明显低估相似度。
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = [];
  for (let i = 0; i < rows; i++) {
    d.push(new Array<number>(cols).fill(0));
    d[i][0] = i;
  }
  for (let j = 0; j < cols; j++) d[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      // 相邻字符交换（transposition）计 1 次编辑
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2][j - 2] + 1);
      }
      d[i][j] = best;
    }
  }
  return d[rows - 1][cols - 1];
}

/** 归一化相似度：1 - 编辑距离 / 两串较长者长度，取值 (0, 1] */
function normalizedSimilarity(name: string, target: string, dist: number): number {
  const maxLen = Math.max(name.length, target.length);
  return maxLen === 0 ? 0 : 1 - dist / maxLen;
}

// ────────────────────────────── 视觉混淆（0↔o、1↔l↔I、rn↔m、vv↔w、c↔с） ──────────────────────────────

/** 单字符混淆映射：同一组内字符互相替换可造成视觉误导 */
const VISUAL_CHAR_MAP: Record<string, readonly string[]> = {
  '0': ['o'],
  o: ['0'],
  '1': ['l', 'I'],
  l: ['1', 'I'],
  I: ['1', 'l'],
  c: ['с'], // 拉丁 c
  с: ['c'], // 西里尔 с
};

/** 双字符 ↔ 单字符混淆：rn↔m、vv↔w */
const VISUAL_PAIR_MAP: Record<string, string> = {
  rn: 'm',
  m: 'rn',
  vv: 'w',
  w: 'vv',
};

/** 生成仅做一次视觉混淆替换的全部变体（与知名包名精确比对） */
function visualConfusionVariants(name: string): string[] {
  const variants: string[] = [];

  for (let i = 0; i < name.length; i++) {
    const reps = VISUAL_CHAR_MAP[name[i]];
    if (!reps) continue;
    for (const rep of reps) {
      variants.push(`${name.slice(0, i)}${rep}${name.slice(i + 1)}`);
    }
  }

  for (let i = 0; i < name.length; i++) {
    for (const [from, to] of Object.entries(VISUAL_PAIR_MAP)) {
      if (name.startsWith(from, i)) {
        variants.push(`${name.slice(0, i)}${to}${name.slice(i + from.length)}`);
      }
    }
  }

  return variants;
}

/** 找出单次视觉混淆后与候选名相等的知名包（无则返回 null） */
function visualConfusionTarget(variantSet: Set<string>): string | null {
  for (const known of KNOWN_PACKAGES) {
    if (variantSet.has(known)) return known;
  }
  return null;
}

// ────────────────────────────── 行为标记（静态可判） ──────────────────────────────

/** 名称中的数字 / 连字符等可疑异常，输出可解释行为标记 */
function collectBehaviorFlags(name: string, target: string): string[] {
  const flags: string[] = [];
  if (CONTAINS_DIGIT_RE.test(name)) flags.push('name-contains-digit');
  if (name.includes('-')) flags.push('name-contains-hyphen');
  // 知名包名 + '-<数字>' 后缀（如 'lodash-2'）：疑似冒名版本号
  if (SAFE_TARGET_RE.test(target) && new RegExp(`^${escapeRegExp(target)}-\\d+$`).test(name)) {
    flags.push('known-name-version-suffix');
  }
  return flags;
}

// ────────────────────────────── 具体实现 ──────────────────────────────

/** 离线静态投毒检测实现：零网络，只消费 DependencyGraph 节点名 */
export class TyposquatDetectorImpl implements TyposquatDetector {
  /**
   * 检测图谱中的 typosquatting 候选。
   *
   * 对每个节点：与知名包清单逐一比对（编辑距离 + 视觉混淆），取最优命中；
   * 命中则按阈值定级并生成可解释证据，结果按风险等级降序排列。
   * 空图谱 / 无命中 → 返回空数组，绝不抛异常。
   */
  async detect(graph: DependencyGraph): Promise<TyposquatFinding[]> {
    const findings: TyposquatFinding[] = [];
    for (const node of graph.nodes) {
      const finding = evaluateNode(node);
      if (finding) findings.push(finding);
    }
    return sortFindings(findings);
  }
}

/** 评估单个节点：scoped / 合法知名包跳过，命中则产出 finding */
function evaluateNode(node: DependencyNode): TyposquatFinding | null {
  if (node.name.startsWith('@')) return null;
  const name = node.name.toLowerCase();
  if (KNOWN_PACKAGES.includes(name)) return null;

  const variantSet = new Set(visualConfusionVariants(name));
  const visualTarget = visualConfusionTarget(variantSet);
  const best = findBestMatch(name, visualTarget);
  if (!best) return null;
  const risk = classifyRisk(best);
  if (risk === null) return null;
  return buildFinding(node, name, best, risk);
}

/** 逐一比对知名包，取编辑距离最小者（同距离时视觉混淆优先） */
function findBestMatch(name: string, visualTarget: string | null): { target: string; dist: number; visual: boolean } | null {
  let bestTarget = '';
  let bestDist = Infinity;
  let bestVisual = false;
  for (const known of KNOWN_PACKAGES) {
    const dist = editDistance(name, known);
    const visual = visualTarget === known;
    if (dist > LOW_RISK_MAX_EDIT_DISTANCE && !visual) continue;
    if (dist < bestDist || (dist === bestDist && visual && !bestVisual)) {
      bestTarget = known;
      bestDist = dist;
      bestVisual = visual;
    }
  }
  if (bestTarget === '') return null;
  return { target: bestTarget, dist: bestDist, visual: bestVisual };
}

/** 风险定级：≤1 或视觉混淆 → high；≤2 → medium；≤3 且常见目标 → low */
function classifyRisk(best: { target: string; dist: number; visual: boolean }): TyposquatFinding['risk'] | null {
  if (best.visual || best.dist <= HIGH_RISK_MAX_EDIT_DISTANCE) return 'high';
  if (best.dist <= MEDIUM_RISK_MAX_EDIT_DISTANCE) return 'medium';
  if (best.dist <= LOW_RISK_MAX_EDIT_DISTANCE && COMMON_TARGETS.has(best.target)) return 'low';
  return null;
}

/** 组装 finding：证据 + 行为标记 + 信号 */
function buildFinding(
  node: DependencyNode,
  name: string,
  best: { target: string; dist: number; visual: boolean },
  risk: TyposquatFinding['risk'],
): TyposquatFinding {
  const score = normalizedSimilarity(name, best.target, best.dist);
  const evidence: string[] = [];
  if (best.visual) {
    evidence.push(
      `name '${node.name}' visually resembles known '${best.target}' (edit distance ${best.dist}, score ${score.toFixed(2)})`,
    );
  } else {
    evidence.push(
      `name '${node.name}' vs known '${best.target}': edit distance ${best.dist} (score ${score.toFixed(2)})`,
    );
  }
  const behaviorFlags = collectBehaviorFlags(node.name, best.target);
  for (const flag of behaviorFlags) {
    evidence.push(`behavior flag: ${flag}`);
  }
  return {
    nodeId: node.id,
    risk,
    signals: {
      nameSimilarity: { target: best.target, score: Number(score.toFixed(2)) },
      ...(behaviorFlags.length > 0 ? { behaviorFlags } : {}),
    },
    evidence,
  };
}

/** 风险降序：high → medium → low；同级按相似度降序，再按包名字典序 */
function sortFindings(findings: TyposquatFinding[]): TyposquatFinding[] {
  const riskRank: Record<TyposquatFinding['risk'], number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => {
    const rankDiff = riskRank[a.risk] - riskRank[b.risk];
    if (rankDiff !== 0) return rankDiff;
    const scoreA = a.signals.nameSimilarity?.score ?? 0;
    const scoreB = b.signals.nameSimilarity?.score ?? 0;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.nodeId.localeCompare(b.nodeId);
  });
  return findings;
}
