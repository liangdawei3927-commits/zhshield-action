import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseFile, computeNestingDepth } from '@zh/refactor';
import { readGateDeclaration } from '@zh/kernel';
import type { RuleMetricsProvider, RuleMetricsResult, SopRule } from '@zh/kernel';

/**
 * 规则度量数据源实现（threshold 指令的实测值）。
 *
 * 存在理由：`evalThreshold` 只负责「拿到实测值 → 与阈值比较」，它不负责取数。
 * 内核不感知 AST、文件系统与覆盖率报告，故取数在 @zh/pipeline 实现后经
 * `EngineHost.metricsProvider` 注入（唯一构造点 = PipelineRunner）。
 *
 * 三条铁律：
 * 1. **测不到就不给**：不用 0、不用默认值顶替。缺项会让规则落 degraded skipped，
 *    「未检测 ≠ 通过」。
 * 2. **口径不符就不算**：规则声明 `scope: diff` 而只能算全量时，宁可判不可用并说明原因，
 *    也不拿全量数字冒充 diff 覆盖率 —— 那是换一种形式的假绿。
 * 3. **按规则 id 显式登记**：分数型规则（`threshold: 70`）会被解释器折算成统一的键
 *    `value`，健康分/质量分/覆盖率三条规则共用该键。若按指标名盲取，三条必然读同一个数。
 */

/** 复杂度指标键（与云端 `inspect.scan.official.complexity` 的 thresholds 对齐） */
export const COMPLEXITY_METRICS = [
  'cyclomaticComplexity',
  'functionLength',
  'fileLength',
  'nestingDepth',
  'parameterCount',
] as const;

const COMPLEXITY_METRIC_SET = new Set<string>(COMPLEXITY_METRICS);

/** 参与复杂度统计的源文件扩展名 */
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);

/**
 * 遍历时跳过的目录（构建产物与依赖，不是被测代码）。
 *
 * 2026-10-29 实测教训：只用精确名 `dist` 匹配时，`packages/desktop/dist-electron/`
 * 下 12 个 800KB 的 esbuild 打包产物被当成源码 —— 复杂度统计耗时 250 秒、
 * `fileLength` 虚高到 22435 行（真实源码最多几百行）。故改为**前缀族匹配**。
 */
const SKIP_DIR_EXACT = new Set([
  'node_modules',
  'coverage',
  'vendor',
  'test-fixtures',
  '__snapshots__',
]);

/** 生成物目录族：dist / dist-electron / build / out / release / output / .next ... */
const SKIP_DIR_PREFIX = /^(dist|build|out|release|output|public|static|generated)([-_.]|$)/i;

/** 生成的单文件：压缩产物与打包产物，行数指标对它们没有意义 */
const GENERATED_FILE = /\.(min|bundle|chunk)\.(js|ts|mjs|cjs)$/i;

/** 单个源文件体积上限：超过即整体放弃统计（静默跳过会让 fileLength 偏低，等于假数据） */
const MAX_FILE_BYTES = 512 * 1024;

function isSkippedDir(name: string): boolean {
  // 点开头的目录（.git/.next/.cache/.turbo）一律跳过；其余按精确名与前缀族判定
  return name.startsWith('.') || SKIP_DIR_EXACT.has(name) || SKIP_DIR_PREFIX.test(name);
}

/** 默认源文件上限：超出即放弃统计（8GB 机解析上万文件会把体检拖成分钟级） */
const DEFAULT_MAX_FILES = 4000;

/** 规则度量提供者的可选项；不传即用内置默认值 */
export interface RuleMetricsOptions {
  /** 复杂度统计的源文件上限；超出则不给该指标（宁可不算也不给半截数字） */
  maxScanFiles?: number;
}

/** 复杂度指标的累计结构 —— 阈值是「上限型」，故取全项目最大值 */
interface ComplexityPeaks {
  cyclomaticComplexity: number;
  functionLength: number;
  fileLength: number;
  nestingDepth: number;
  parameterCount: number;
}

/**
 * 创建规则度量提供者。每次 PipelineRunner 构造一个实例；
 * 同一次扫描内多条规则复用同一份统计结果（避免重复解析整个项目）。
 */
export function createRuleMetricsProvider(
  repoRoot: string,
  options: RuleMetricsOptions = {},
): RuleMetricsProvider {
  const cache = new Map<string, RuleMetricsResult>();
  const memo = (key: string, compute: () => RuleMetricsResult): RuleMetricsResult => {
    const hit = cache.get(key);
    if (hit) return hit;
    const value = compute();
    cache.set(key, value);
    return value;
  };

  return (rule: SopRule): RuleMetricsResult => {
    const declared = readDeclaredMetricKeys(rule);
    // 没声明指标 ⇒ 交给 evalThreshold 判「未执行」，这里不算错
    if (declared.length === 0) return { metrics: {} };

    if (declared.every((key) => COMPLEXITY_METRIC_SET.has(key))) {
      return memo('complexity', () => measureComplexity(repoRoot, options));
    }

    return {
      unavailableReason:
        `未登记度量口径（规则「${rule.id}」声明指标: ${declared.join(', ')}）——` +
        '引擎内阈值规则须在 packages/pipeline/src/rule-metrics.ts 登记取数方式；' +
        '若依赖整轮扫描的聚合结果（健康分/质量分/覆盖率），应登记为扫描后门禁' +
        '（kernel/src/runner/post-scan-gate.ts），由 gate 阶段判定',
    };
  };
}

/**
 * 从规则声明中读出「它要哪些指标」。
 *
 * 实现在 kernel 的 `readGateDeclaration`（与门禁判定共用一份读法）：
 * 复数 `thresholds` 取各键名，单数 `threshold` 折叠为 `value`。
 * 另写一份必然漂移 —— 届时 provider 认为规则要 `value`、gate 认为要 `coverage`。
 */
export function readDeclaredMetricKeys(rule: SopRule): string[] {
  return [...readGateDeclaration(rule).declaredMetrics];
}

// ─── 复杂度 ────────────────────────────────────────────

function measureComplexity(repoRoot: string, options: RuleMetricsOptions): RuleMetricsResult {
  const limit = options.maxScanFiles ?? DEFAULT_MAX_FILES;
  const files = collectSourceFiles(repoRoot, limit);
  if (files.truncated) {
    return {
      unavailableReason:
        `源文件数超过 ${limit} 个上限，已放弃复杂度统计（遍历被截断会给出一份偏低的假数据，` +
        '如需覆盖全量请调大 maxScanFiles）',
    };
  }
  if (files.oversize.length > 0) {
    return {
      unavailableReason:
        `存在超过 ${Math.round(MAX_FILE_BYTES / 1024)}KB 的源文件（如 ${files.oversize[0]}），` +
        '跳过一个文件会让 fileLength / cyclomaticComplexity 偏低 —— 宁可不给，也不给偏低的假数据',
    };
  }
  if (files.paths.length === 0) {
    return { unavailableReason: `在 ${repoRoot} 下未找到可分析的源文件（.ts/.tsx/.js/.jsx）` };
  }

  const peaks: ComplexityPeaks = {
    cyclomaticComplexity: 0,
    functionLength: 0,
    fileLength: 0,
    nestingDepth: 0,
    parameterCount: 0,
  };
  let parsed = 0;
  for (const filePath of files.paths) {
    const measured = measureFile(filePath);
    if (!measured) continue;
    parsed += 1;
    peaks.cyclomaticComplexity = Math.max(peaks.cyclomaticComplexity, measured.cyclomaticComplexity);
    peaks.functionLength = Math.max(peaks.functionLength, measured.functionLength);
    peaks.fileLength = Math.max(peaks.fileLength, measured.fileLength);
    peaks.nestingDepth = Math.max(peaks.nestingDepth, measured.nestingDepth);
    peaks.parameterCount = Math.max(peaks.parameterCount, measured.parameterCount);
  }
  if (parsed === 0) {
    return { unavailableReason: '所有源文件均解析失败，未得到任何复杂度数据' };
  }
  return { metrics: { ...peaks } };
}

function measureFile(filePath: string): ComplexityPeaks | undefined {
  let parsed;
  try {
    parsed = parseFile(filePath);
  } catch {
    // 单个文件解析失败不影响全项目统计（语法扩展名不匹配等），跳过即可
    return undefined;
  }
  const peaks: ComplexityPeaks = {
    cyclomaticComplexity: 0,
    functionLength: 0,
    fileLength: countLines(parsed.sourceFile.text),
    nestingDepth: 0,
    parameterCount: 0,
  };
  const record = (complexity: number, lineCount: number, parameterCount: number, depth: number) => {
    peaks.cyclomaticComplexity = Math.max(peaks.cyclomaticComplexity, complexity);
    peaks.functionLength = Math.max(peaks.functionLength, lineCount);
    peaks.parameterCount = Math.max(peaks.parameterCount, parameterCount);
    peaks.nestingDepth = Math.max(peaks.nestingDepth, depth);
  };

  for (const fn of parsed.functions) {
    record(fn.complexity, fn.lineCount, fn.parameterCount, computeNestingDepth(fn.node));
  }
  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      record(
        method.complexity,
        method.lineCount,
        method.parameterCount,
        computeNestingDepth(method.node),
      );
    }
  }
  return peaks;
}

/** 物理行数（含空行与注释）：`fileLength` 口径按文件总行数，与编辑器显示一致 */
function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

interface CollectResult {
  paths: string[];
  truncated: boolean;
  oversize: string[];
}

function collectSourceFiles(repoRoot: string, limit: number): CollectResult {
  const result: CollectResult = { paths: [], truncated: false, oversize: [] };
  const stack = [repoRoot];
  while (stack.length > 0 && !result.truncated) {
    const dir = stack.pop() as string;
    for (const entry of readDir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isSkippedDir(entry.name)) stack.push(full);
        continue;
      }
      if (!acceptSourceFile(repoRoot, full, entry.name, result.oversize)) continue;
      result.paths.push(full);
      // 截断必须显式标记：静默少算会让复杂度指标偏低，等于喂假数据
      result.truncated = result.paths.length > limit;
      if (result.truncated) break;
    }
  }
  return result;
}

function readDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // 无权限目录直接跳过，不中断整体统计
  }
}

/** 判断单个文件是否纳入统计；超限文件记入 oversize（调用方据此整体放弃，而非静默跳过） */
function acceptSourceFile(
  repoRoot: string,
  full: string,
  name: string,
  oversize: string[],
): boolean {
  if (name.startsWith('.') || !SOURCE_EXTS.has(path.extname(name))) return false;
  if (name.endsWith('.d.ts') || GENERATED_FILE.test(name)) return false;
  if (fileSize(full) > MAX_FILE_BYTES) {
    oversize.push(path.relative(repoRoot, full));
    return false;
  }
  return true;
}

function fileSize(full: string): number {
  try {
    return fs.statSync(full).size;
  } catch {
    return 0;
  }
}
