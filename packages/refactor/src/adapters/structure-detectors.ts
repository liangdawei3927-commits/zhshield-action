import * as fs from 'fs';
import * as path from 'path';
import type { DuplicateBlock, ParsedFile } from '../ast-helper';
import { computeNestingDepth, scanDuplicateCodeBlocks } from '../ast-helper';
import type { CodeSmell, RefactorConfig } from '../types';
import { makeSmell } from './adapter-types';

const BLANK_LINE_BLOCK = /\n\s*\n/;

export function detectDeepNesting(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];
  const threshold = config.thresholds.maxNestingDepth;

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      const depth = computeNestingDepth(method.node);
      if (depth > threshold) {
        const sm = makeSmell({
          ruleId: 'deep-nesting',
          severity: config.severities['deep-nesting'],
          message: `${cls.name}.${method.name}() 嵌套过深 (${depth} 层，阈值 ${threshold})，建议使用 guard clause 或提取方法`,
          filePath: parsed.filePath,
          line:
            parsed.sourceFile.getLineAndCharacterOfPosition(method.node.getStart(parsed.sourceFile))
              .line + 1,
          column: 1,
          metric: 'nestingDepth',
          value: depth,
          threshold,
          suggestion: {
            type: 'Flatten / Early Return',
            description: `使用 guard clause 提前返回，或将深层分支提取为独立函数`,
            priority: depth > threshold * 1.5 ? 'high' : 'medium',
            effort: 'small',
            autoFixable: false,
          },
        });
        smells.push(sm);
      }
    }
  }

  for (const fn of parsed.functions) {
    const depth = computeNestingDepth(fn.node);
    if (depth > threshold) {
      smells.push(
        makeSmell({
          ruleId: 'deep-nesting',
          severity: config.severities['deep-nesting'],
          message: `${fn.name}() 嵌套过深 (${depth} 层)`,
          filePath: parsed.filePath,
          line: fn.startLine,
          column: 1,
          metric: 'nestingDepth',
          value: depth,
          threshold,
          suggestion: {
            type: 'Flatten / Early Return',
            description: '使用 guard clause 提前返回，或将深层分支提取为独立函数',
            priority: depth > threshold * 1.5 ? 'high' : 'medium',
            effort: 'small',
            autoFixable: false,
          },
        }),
      );
    }
  }

  return smells;
}

export function detectMixedResponsibilities(
  parsed: ParsedFile,
  config: RefactorConfig,
): CodeSmell[] {
  const smells: CodeSmell[] = [];
  const threshold = config.thresholds.minResponsibilities;

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      const source = method.node.getText(parsed.sourceFile);
      const responsibilityCount = countResponsibilities(source);

      if (responsibilityCount > threshold) {
        smells.push(
          makeSmell({
            ruleId: 'mixed-responsibilities',
            severity: config.severities['mixed-responsibilities'],
            message: `${cls.name}.${method.name}() 混合了约 ${responsibilityCount} 个职责 (阈值 ${threshold})，建议拆分为独立函数`,
            filePath: parsed.filePath,
            line:
              parsed.sourceFile.getLineAndCharacterOfPosition(
                method.node.getStart(parsed.sourceFile),
              ).line + 1,
            column: 1,
            metric: 'responsibilityCount',
            value: responsibilityCount,
            threshold,
            suggestion: {
              type: 'Extract Function per Responsibility',
              description: `按注释分区 / 空行分隔 / try/catch 边界将方法拆分为多个独立函数`,
              priority: responsibilityCount > threshold + 2 ? 'high' : 'medium',
              effort: responsibilityCount > threshold + 3 ? 'large' : 'medium',
              autoFixable: false,
            },
          }),
        );
      }
    }
  }

  for (const fn of parsed.functions) {
    const source = fn.node.getText(parsed.sourceFile);
    const responsibilityCount = countResponsibilities(source);
    if (responsibilityCount > threshold) {
      smells.push(
        makeSmell({
          ruleId: 'mixed-responsibilities',
          severity: config.severities['mixed-responsibilities'],
          message: `${fn.name}() 混合了约 ${responsibilityCount} 个职责`,
          filePath: parsed.filePath,
          line: fn.startLine,
          column: 1,
          metric: 'responsibilityCount',
          value: responsibilityCount,
          threshold,
          suggestion: {
            type: 'Extract Function per Responsibility',
            description: '按职责将函数拆分为多个独立函数',
            priority: responsibilityCount > threshold + 2 ? 'high' : 'medium',
            effort: responsibilityCount > threshold + 3 ? 'large' : 'medium',
            autoFixable: false,
          },
        }),
      );
    }
  }

  return smells;
}

function countResponsibilities(source: string): number {
  let count = 0;
  count += countCommentSections(source);
  count += countBlankLineBlocks(source);
  count += countTryCatchBlocks(source);

  if (count === 0 && source.split('\n').length > 40) {
    count = 1;
  }

  return count;
}

/** 按注释分区（分隔线 / 步骤编号 / 冒号标注 / 大写开头）计数 */
function countCommentSections(source: string): number {
  const commentSections = source.match(
    /\/\/\s*[-=_]{3,}|\/\/\s*步骤\s*\d+|\/\/\s*.+?[:：]|(\/\/\s*[A-Z][a-zA-Z])/g,
  );
  return commentSections ? commentSections.length : 0;
}

/** 按空行分隔的代码块计数（超过 2 块才累计） */
function countBlankLineBlocks(source: string): number {
  const blankLineBlocks = source.split(BLANK_LINE_BLOCK).filter((b) => b.trim().length > 20).length;
  return blankLineBlocks > 2 ? Math.max(0, blankLineBlocks - 1) : 0;
}

function countTryCatchBlocks(source: string): number {
  const tryCatchBlocks = source.match(/try\s*{/g);
  return tryCatchBlocks ? tryCatchBlocks.length : 0;
}

let _dupCache: DuplicateBlock[] | null = null;
let _dupCacheFiles: ParsedFile[] | null = null;
let _dupCacheMinLines: number = 0;

export function detectDuplicateCode(
  parsed: ParsedFile,
  allFiles: ParsedFile[],
  config: RefactorConfig,
): CodeSmell[] {
  const minLines = config.thresholds.minDuplicateLines;
  return getDuplicateBlocks(allFiles, minLines)
    // 每对重复区只由字典序在前的文件报告一次。此前两侧各报一条，问题总数虚高
    // 约一倍（2026-10-28 对账实证：696 条 = 348 对 × 2），且 MCP 分页截断下
    // 正反两条还会让「同文件被卷入 N 次」的模块统计失真。
    .filter((d) => canonicalSideOf(d) === parsed.filePath)
    .map((dup) => buildDuplicateSmell(parsed, dup, config, minLines));
}

/** 重复对的规范报告侧：两文件中字典序在前的那个（确定性，扫描顺序无关） */
function canonicalSideOf(d: DuplicateBlock): string {
  return d.files[0] <= d.files[1] ? d.files[0] : d.files[1];
}

function getDuplicateBlocks(allFiles: ParsedFile[], minLines: number): DuplicateBlock[] {
  if (_dupCache === null || _dupCacheFiles !== allFiles || _dupCacheMinLines !== minLines) {
    // 缓存完整重复区列表：报告上限只在展示层（zhcheck 文本打印）生效，
    // 数据路径不截断，否则基线计数会随窗口移动而漂移。
    _dupCache = scanDuplicateCodeBlocks(allFiles, minLines);
    _dupCacheFiles = allFiles;
    _dupCacheMinLines = minLines;
  }
  return _dupCache;
}

/** monorepo 包路径段 `packages/<name>/`；模块级复用，避免每次调用重新编译正则 */
const PACKAGE_PATH_RE = /packages\/([^/]+)\//;

/** 从绝对路径提取 monorepo 包名（packages/<name>/ 段），非包内文件返回 null */
function packageNameOf(filePath: string): string | null {
  const m = filePath.match(PACKAGE_PATH_RE);
  return m ? m[1] : null;
}

/**
 * 跨包重复的落点建议：按两侧包的真实依赖方向动态判定（读取各自 package.json
 * 声明的 @zh/* 依赖，结果按包缓存），不再使用固定的「不可直接互引」模板——
 * 2026-10-28 对账实证：该文案在跨包场景无条件打印，会把「desktop 已依赖 db」
 * 这类可正常互引的配对也误描述成依赖倒挂。
 * - 上游已依赖：落点下沉到被依赖包的公共模块，直接引用；
 * - 互不依赖：落点上提至共同上游公共包（如 @zh/shared / @zh/kernel）。
 */
function landingAdvice(myFile: string, otherFile: string): string {
  const mine = packageNameOf(myFile);
  const other = packageNameOf(otherFile);
  if (mine && other && mine !== other) {
    const root = repoRootOf(myFile) ?? repoRootOf(otherFile);
    if (root) {
      if (declaredZhDeps(root, mine).has(other)) {
        return `两文件分属 @zh/${mine} 与 @zh/${other}，且 @zh/${mine} 已依赖 @zh/${other}：落点下沉到 @zh/${other} 的公共模块，由 @zh/${mine} 直接引用`;
      }
      if (declaredZhDeps(root, other).has(mine)) {
        return `两文件分属 @zh/${mine} 与 @zh/${other}，且 @zh/${other} 已依赖 @zh/${mine}：落点下沉到 @zh/${mine} 的公共模块，由 @zh/${other} 直接引用`;
      }
      return `两文件分属 @zh/${mine} 与 @zh/${other}（互相不依赖）：落点上提至两者共同依赖的上游公共包（如 @zh/shared / @zh/kernel）`;
    }
    return `两文件分属 @zh/${mine} 与 @zh/${other}：落点上提至 @zh/shared / @zh/kernel 或依赖方向上的下游包`;
  }
  return `落点选在 ${mine ? `@zh/${mine}` : '所在包'} 的公共模块，避免第三处复制`;
}

/** 从 `…/packages/<pkg>/…` 路径反推 monorepo 根；非包内文件返回 null */
function repoRootOf(filePath: string): string | null {
  const marker = '/packages/';
  const idx = filePath.lastIndexOf(marker);
  return idx === -1 ? null : filePath.slice(0, idx);
}

/** 包依赖方向缓存：`repoRoot::pkg` → 其清单声明的 @zh/* 依赖名集合 */
const pkgDepsCache = new Map<string, ReadonlySet<string>>();

/** 包清单中参与依赖判定的四类依赖段 */
const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** 取单个依赖段中的 @zh/* 包名（去前缀）；空段/非对象段返回空数组 */
function zhDepsOfSection(sec: unknown): string[] {
  if (!sec || typeof sec !== 'object') return [];
  return Object.keys(sec as Record<string, unknown>)
    .filter((name) => name.startsWith('@zh/'))
    .map((name) => name.slice('@zh/'.length));
}

/** 从已解析的包清单收集全部 @zh/* 依赖名（四类依赖段合集） */
function zhDepsOfManifest(manifest: Record<string, unknown>): ReadonlySet<string> {
  const deps = new Set<string>();
  for (const section of DEP_SECTIONS) {
    for (const name of zhDepsOfSection(manifest[section])) {
      deps.add(name);
    }
  }
  return deps;
}

/** 读取包清单里声明的 @zh/* 依赖（四类依赖段合集）；读不到按空集处理 */
function declaredZhDeps(repoRoot: string, pkg: string): ReadonlySet<string> {
  const key = `${repoRoot}::${pkg}`;
  const cached = pkgDepsCache.get(key);
  if (cached) return cached;

  let deps: ReadonlySet<string>;
  try {
    const raw = fs.readFileSync(path.join(repoRoot, 'packages', pkg, 'package.json'), 'utf8');
    deps = zhDepsOfManifest(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    // 清单缺失/损坏按无依赖处理：跨包场景回退到「上提 shared/kernel」的保守建议
    deps = new Set<string>();
  }

  pkgDepsCache.set(key, deps);
  return deps;
}

function buildDuplicateSmell(
  parsed: ParsedFile,
  dup: DuplicateBlock,
  config: RefactorConfig,
  minLines: number,
): CodeSmell {
  const isFirst = dup.files[0] === parsed.filePath;
  const otherFile = isFirst ? dup.files[1] : dup.files[0];
  const myLine = isFirst ? dup.lines[0] : dup.lines[1];
  const otherLine = isFirst ? dup.lines[1] : dup.lines[0];
  return makeSmell({
    ruleId: 'duplicated-code',
    severity: config.severities['duplicated-code'],
    message: `代码块与 ${otherFile}:${otherLine} 重复，建议提取为公共函数`,
    filePath: parsed.filePath,
    line: myLine,
    column: 1,
    metric: 'duplicateLines',
    // 值为重复区实际行数（原本误用 dup.code.length —— 那是被截断到 80 的
    // 归一化字符数，与 metric 名 duplicateLines 语义不符，且恒不超 80）
    value: dup.lineCount,
    threshold: minLines,
    suggestion: {
      type: 'Extract Common Function',
      description: `将重复代码提取为公共函数，通过参数化差异点统一调用。${landingAdvice(parsed.filePath, otherFile)}`,
      priority: 'medium',
      effort: 'medium',
      autoFixable: false,
    },
    endLine: myLine + dup.lineCount - 1,
  });
}

export function detectCallbackHell(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      const methodText = method.node.getText(parsed.sourceFile);
      const chainCount = (methodText.match(/\.then\(/g) || []).length;

      if (chainCount > 3) {
        smells.push(
          makeSmell({
            ruleId: 'callback-hell',
            severity: config.severities['callback-hell'],
            message: `${cls.name}.${method.name}() 包含 ${chainCount} 层 .then() 链式回调，建议转换为 async/await`,
            filePath: parsed.filePath,
            line:
              parsed.sourceFile.getLineAndCharacterOfPosition(
                method.node.getStart(parsed.sourceFile),
              ).line + 1,
            column: 1,
            metric: 'thenChainCount',
            value: chainCount,
            threshold: 3,
            suggestion: {
              type: 'Convert to Async/Await',
              description: '将 .then() 链式回调转换为 async/await 语法，保留 try/catch 错误处理',
              priority: chainCount > 5 ? 'high' : 'medium',
              effort: 'small',
              autoFixable: true,
            },
          }),
        );
      }
    }
  }

  return smells;
}
