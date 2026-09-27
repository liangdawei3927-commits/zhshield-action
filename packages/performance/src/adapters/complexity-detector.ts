/**
 * 代码复杂度检测器（complexity-detector.ts）
 *
 * 纯静态分析源码复杂度（零网络、零执行）：
 * - nested-loop：三层以上真实 AST 嵌套循环 → medium
 * - sync-io：落在延迟敏感执行上下文里的同步阻塞 IO → high
 *
 * 判定全部基于 TypeScript 编译器 API（事实见 ast-scan.ts，上下文政策见
 * runtime-context.ts），本文件只负责取文件、组装 issue。
 * 文件缺失 / 目录不存在均按静默跳过处理，不抛异常。
 */
import * as path from 'path';
import { DEFAULT_CONFIG, type PerformanceConfig, type PerformanceIssue } from '../types';
import {
  resolveSourceRoots,
  collectFilesAcrossRoots,
  collectSourceFiles,
  readTextSafe,
  SOURCE_EXTS,
  SKIPPED_SOURCE_DIRS,
} from '../source-roots';
import { scanSourceFile, type FileScan } from './ast-scan';
import { classifyRuntime, isLatencySensitive, type RuntimeContext } from './runtime-context';

const NESTED_LOOP_THRESHOLD = 3;

/** 复杂度检测器契约：对项目根执行静态复杂度分析并产出性能问题列表 */
export interface ComplexityDetector {
  detect(projectRoot: string, config?: PerformanceConfig): PerformanceIssue[];
}

/** 永不返回的穷尽兜底：新增上下文成员而忘记补分支时在此编译期报错 */
function assertNever(value: never): never {
  throw new Error(`未覆盖的运行时上下文: ${String(value)}`);
}

/** 该上下文下「同步阻塞」的真实后果：阻塞的是谁、怎么改（不用浏览器话术套 Node） */
function impactOf(context: RuntimeContext): { label: string; impact: string; advice: string } {
  switch (context) {
    case 'browser':
      return {
        label: '浏览器主线程',
        impact: '同步阻塞页面主线程，影响页面响应',
        advice: '改用异步 API，或把重活移至 Worker 线程',
      };
    case 'electron-renderer':
      return {
        label: 'Electron 渲染进程',
        impact: '同步阻塞渲染线程，界面出现卡顿',
        advice: '改用异步版本（fs/promises），或把重活移到主进程执行',
      };
    case 'electron-main':
      return {
        label: 'Electron 主进程事件循环',
        impact: '同步阻塞主进程事件循环，窗口无响应',
        advice: '改用异步版本（fs/promises），让出事件循环',
      };
    case 'node':
      return {
        label: 'Node 服务端请求路径',
        impact: '同步阻塞事件循环，同时到达的并发请求被一起挂起',
        advice: '改用异步版本（fs/promises），让出事件循环',
      };
    default:
      return assertNever(context);
  }
}

/**
 * ComplexityDetectorImpl — 基于 AST 的复杂度检测实现
 *
 * 检出两类问题：三层以上嵌套循环（medium）与延迟敏感路径上的同步阻塞 IO（high）。
 * 文件缺失 / 目录不存在均静默跳过，不抛异常。
 */
export class ComplexityDetectorImpl implements ComplexityDetector {
  detect(projectRoot: string, config?: PerformanceConfig): PerformanceIssue[] {
    const cfg: PerformanceConfig = { ...DEFAULT_CONFIG, ...(config ?? {}) };
    const issues: PerformanceIssue[] = [];
    const files = collectFilesAcrossRoots(
      resolveSourceRoots(projectRoot),
      (root, limit) => collectSourceFiles(root, SOURCE_EXTS, SKIPPED_SOURCE_DIRS, limit),
      cfg.scanLimit,
    );

    for (const filePath of files) {
      const content = readTextSafe(filePath);
      if (content === null) continue;
      const rel = path.relative(projectRoot, filePath).split(path.sep).join('/');
      const scan = scanSourceFile(rel, content);
      this.detectNestedLoop(rel, scan, issues);
      this.detectSyncIO(rel, scan, issues);
    }
    return issues;
  }

  private detectNestedLoop(
    relFile: string,
    scan: FileScan,
    issues: PerformanceIssue[],
  ): void {
    const chain = scan.deepestLoops;
    if (chain === null || chain.depth < NESTED_LOOP_THRESHOLD) return;
    const { depth, innermostIterable, outermostLine } = chain;
    issues.push({
      id: `complexity-nested-loop-${relFile}`,
      ruleId: 'complexity.nested-loop',
      category: 'complexity',
      severity: 'medium',
      file: relFile,
      line: outermostLine,
      message:
        `${relFile} 存在 ${depth} 层嵌套循环` +
        `（最内层遍历 ${innermostIterable}）— 循环层级过深，建议提取内层或预建索引`,
      suggestion: '将最内层循环体提取为独立函数，或用 Map/Set 预建索引替代内层遍历',
      autoFixable: false,
    });
  }

  private detectSyncIO(
    relFile: string,
    scan: FileScan,
    issues: PerformanceIssue[],
  ): void {
    const context = classifyRuntime(scan);
    const seen = new Set<string>();
    for (const site of scan.syncCalls) {
      if (!isLatencySensitive(site, context)) continue;
      if (seen.has(site.apiName)) continue;
      seen.add(site.apiName);
      const { label, impact, advice } = impactOf(context);
      issues.push({
        id: `complexity-sync-io-${relFile}-${site.apiName}`,
        ruleId: 'complexity.sync-io',
        category: 'complexity',
        severity: 'high',
        file: relFile,
        line: site.line,
        message: `${relFile} 在${label}调用了 ${site.apiName}() — ${impact}`,
        suggestion: `将 ${site.apiName}() 换为异步版本；${advice}`,
        autoFixable: false,
      });
    }
  }
}

/** 复杂度检测器单例（供适配器注册表直接引用） */
export const complexityDetector: ComplexityDetector = new ComplexityDetectorImpl();
