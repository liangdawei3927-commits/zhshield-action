/**
 * 升级评估适配器（upgrade-evaluator.ts）
 *
 * 纯离线静态实现：基于内置「已知大版本目录」比对节点当前版本，
 * 产出升级候选与破坏性变更说明。不联网、不查询 registry；
 * 未知包返回空候选，扫描 / 解析失败按缺失处理，绝不抛异常。
 *
 * 排序规则（附 B.4）：securityRelevant（修复漏洞）置顶 →
 * 破坏性风险低者优先 → 落后版本最久者优先。
 *
 * code-scan（附 B.4）：仅在提供 projectRoot 且 scanLimit > 0 时，
 * 递归扫描 src/ 下的源码文件（跳过 node_modules / dist / .git，
 * 文件数受 scanLimit 约束，默认 50，防 DoS），收集 import/require
 * 该包的受影响文件清单。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { DependencyNode } from '../types';

/** 升级评估器：对单个依赖节点产出升级评估 */
export interface UpgradeEvaluator {
  evaluate(node: DependencyNode, options?: UpgradeEvaluatorOptions): Promise<UpgradeAssessment>;
}

/** 升级评估结果 */
export interface UpgradeAssessment {
  /** 节点 id，形如 'react@18.2.0' */
  nodeId: string;
  /** 升级候选，按建议优先级排序（安全修复最前） */
  candidates: UpgradeCandidate[];
}

/** 单个升级候选 */
export interface UpgradeCandidate {
  /** 目标版本 */
  targetVersion: string;
  /** 破坏性风险级别 */
  risk: 'low' | 'medium' | 'high';
  /** 破坏性变更明细（附受影响文件） */
  breakingChanges: BreakingChange[];
  /** 是否修复已知漏洞（置顶依据） */
  securityRelevant: boolean;
  /** 人类可读的升级理由 */
  reason: string;
}

/** 破坏性变更说明 */
export interface BreakingChange {
  /** 变更类型，如 'API 变更' / '行为变更' */
  type: string;
  /** 变更描述 */
  description: string;
  /** 受影响的源码文件（code-scan 层；未扫描时为空数组） */
  affectedFiles: string[];
}

/** 升级评估选项 */
export interface UpgradeEvaluatorOptions {
  /** 项目根目录；提供时执行 code-scan 收集受影响文件 */
  projectRoot?: string;
  /** code-scan 文件数上限（防 DoS），默认 50；0 表示不扫描 */
  scanLimit?: number;
}

/** 目录条目：已知的目标大版本及其升级说明 */
export interface CatalogEntry {
  targetVersion: string;
  risk: 'low' | 'medium' | 'high';
  securityRelevant: boolean;
  reason: string;
  breakingChanges: Array<{ type: string; description: string }>;
}

/** 内置升级目录：包名 → 候选条目列表 */
export type UpgradeCatalog = Record<string, CatalogEntry[]>;

/** 内置静态升级目录（离线数据源，覆盖常见大版本跃迁） */
export const DEFAULT_UPGRADE_CATALOG: UpgradeCatalog = {
  react: [
    {
      targetVersion: '18',
      risk: 'low',
      securityRelevant: false,
      reason: '从 17 升级至 18：并发特性（Concurrent）稳定，需将 ReactDOM.render 迁移为 createRoot',
      breakingChanges: [
        { type: 'API 变更', description: 'ReactDOM.render / unmountComponentAtNode 移除，改用 createRoot' },
        { type: '行为变更', description: '自动批处理覆盖更多场景，副作用时序可能变化' },
      ],
    },
    {
      targetVersion: '19',
      risk: 'medium',
      securityRelevant: false,
      reason: '从 17/18 升级至 19：移除遗留 API，需使用 react-dom 的 createRoot 并检查 ref 回调语义',
      breakingChanges: [
        { type: 'API 变更', description: '移除对 IE 的支持与部分遗留 props（如 string ref）' },
        { type: '行为变更', description: 'ref 回调在清理阶段不再以 null 调用，HMR 相关生命周期调整' },
      ],
    },
  ],
  vue: [
    {
      targetVersion: '3',
      risk: 'low',
      securityRelevant: false,
      reason: '升级至 Vue 3：Composition API 与更好的 Tree-shaking 支持',
      breakingChanges: [
        { type: 'API 变更', description: '全局 API 改为应用实例挂载（createApp），filter 移除' },
      ],
    },
  ],
  lodash: [
    {
      targetVersion: '4.17.21',
      risk: 'low',
      securityRelevant: true,
      reason: '锁定安全修复版本：4.17.21 修复原型污染（prototype pollution）等已知漏洞',
      breakingChanges: [{ type: '安全修复', description: '修复 prototype pollution（CVE 相关），行为与 4.x 兼容' }],
    },
  ],
  express: [
    {
      targetVersion: '5',
      risk: 'high',
      securityRelevant: true,
      reason: '升级至 Express 5：修复 path-to-regexp ReDoS 等安全缺陷，路由通配语法有破坏性变化',
      breakingChanges: [
        { type: '路由语法', description: '通配符 * 改为具名通配 {*splat}，正则路由写法变更' },
        { type: 'API 变更', description: 'res.send(status) 移除，需改为 res.status(status).send()' },
      ],
    },
  ],
  webpack: [
    {
      targetVersion: '5',
      risk: 'high',
      securityRelevant: false,
      reason: '升级至 webpack 5：持久化缓存与更好的模块联邦支持，需迁移部分 loader / plugin',
      breakingChanges: [
        { type: '配置变更', description: 'Node.js 内置模块 polyfill 不再自动注入，需显式配置' },
        { type: 'API 变更', description: '部分 loader / plugin 需升级至 webpack 5 兼容版本' },
      ],
    },
  ],
  typescript: [
    {
      targetVersion: '5',
      risk: 'medium',
      securityRelevant: false,
      reason: '升级至 TypeScript 5：更快的构建与更精确的推断，个别类型推断结果可能变化',
      breakingChanges: [
        { type: '行为变更', description: '部分 lib 类型收紧（如 NodeJS.Timeout），个别第三方声明需调整' },
      ],
    },
  ],
  vite: [
    {
      targetVersion: '5',
      risk: 'medium',
      securityRelevant: false,
      reason: '升级至 Vite 5：基于 Rollup 4，Node 版本要求提升，插件需检查兼容性',
      breakingChanges: [
        { type: '环境要求', description: '要求 Node.js 18+，部分旧插件需升级' },
      ],
    },
  ],
  axios: [
    {
      targetVersion: '1',
      risk: 'medium',
      securityRelevant: true,
      reason: '升级至 axios 1.x：修复原型污染 / SSRF 等安全缺陷，默认适配器与请求体序列化行为调整',
      breakingChanges: [
        { type: '行为变更', description: '默认 adapter 从 XHR 切换（Node 下自动选择），FormData / URLSearchParams 序列化差异' },
      ],
    },
  ],
};

/** code-scan 文件数上限默认值（防 DoS） */
const DEFAULT_SCAN_LIMIT = 50;

/** 目录中禁止扫描的目录名 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

/** 转义正则特殊字符（包名可能含 @ / - .） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 解析版本号为数值段（major, minor, patch；缺失补 0，无法解析视为 0） */
function parseVersion(version: string): number[] {
  const nums = version.split('.');
  const parts: number[] = [];
  for (const part of nums.slice(0, 3)) {
    const n = Number.parseInt(part, 10);
    parts.push(Number.isNaN(n) ? 0 : n);
  }
  while (parts.length < 3) parts.push(0);
  return parts;
}

/** 比较两版本：a < b 返回负数，a > b 返回正数 */
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** 当前版本与目标版本间的落后距离（major 权重最大，用于「落后最久优先」） */
function behindDistance(current: string, target: string): number {
  const pc = parseVersion(current);
  const pt = parseVersion(target);
  return (pt[0] - pc[0]) * 1_000_000 + (pt[1] - pc[1]) * 1_000 + (pt[2] - pc[2]);
}

/**
 * code-scan：递归扫描 projectRoot/src 下的源码文件，收集 import / require
 * 指定包名的文件。跳过 node_modules / dist / .git，扫描文件数受 scanLimit
 * 约束；任何读取失败按缺失处理。返回相对 projectRoot 的文件路径。
 */
function scanAffectedFiles(projectRoot: string, packageName: string, scanLimit: number): string[] {
  const srcDir = path.join(projectRoot, 'src');
  const affected: string[] = [];
  let scanned = 0;
  const importRe = new RegExp(
    `(?:from\\s*|import\\s*\\(?\\s*|require\\(\\s*)['"]${escapeRegExp(packageName)}['"]`,
  );

  const walk = (dir: string): void => {
    if (scanned >= scanLimit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // 目录不可读时跳过
      return;
    }
    for (const entry of entries) {
      if (scanned >= scanLimit) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (scanned >= scanLimit) return;
      scanned++;
      let content: string;
      try {
        content = fs.readFileSync(full, 'utf-8');
      } catch {
        // 文件不可读时跳过
        continue;
      }
      if (importRe.test(content)) affected.push(path.relative(projectRoot, full));
    }
  };

  walk(srcDir);
  return affected;
}

/** 按附 B.4 排序：securityRelevant 置顶 → 风险低者优先 → 落后最久优先 */
function compareCandidates(current: string, a: UpgradeCandidate, b: UpgradeCandidate): number {
  if (a.securityRelevant !== b.securityRelevant) return a.securityRelevant ? -1 : 1;
  const riskOrder: Record<UpgradeCandidate['risk'], number> = { low: 0, medium: 1, high: 2 };
  const riskDiff = riskOrder[a.risk] - riskOrder[b.risk];
  if (riskDiff !== 0) return riskDiff;
  return behindDistance(current, b.targetVersion) - behindDistance(current, a.targetVersion);
}

/** 升级评估器具体实现（离线静态目录算法） */
export class UpgradeEvaluatorImpl implements UpgradeEvaluator {
  constructor(private readonly catalog: UpgradeCatalog = DEFAULT_UPGRADE_CATALOG) {}

  async evaluate(node: DependencyNode, options?: UpgradeEvaluatorOptions): Promise<UpgradeAssessment> {
    const entries = this.catalog[node.name] ?? [];
    const scanLimit = options?.scanLimit ?? DEFAULT_SCAN_LIMIT;
    const projectRoot = options?.projectRoot;

    // code-scan：仅在提供 projectRoot 且 scanLimit > 0 时执行（防 DoS）
    let affectedFiles: string[] = [];
    if (projectRoot && scanLimit > 0) {
      affectedFiles = scanAffectedFiles(projectRoot, node.name, scanLimit);
    }

    const candidates: UpgradeCandidate[] = entries
      .filter((entry) => compareVersions(node.version, entry.targetVersion) < 0)
      .map((entry) => ({
        targetVersion: entry.targetVersion,
        risk: entry.risk,
        securityRelevant: entry.securityRelevant,
        reason: entry.reason,
        breakingChanges: entry.breakingChanges.map((note) => ({ ...note, affectedFiles })),
      }))
      .sort((a, b) => compareCandidates(node.version, a, b));

    return { nodeId: node.id, candidates };
  }
}
