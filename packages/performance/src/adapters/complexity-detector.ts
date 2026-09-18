/**
 * 代码复杂度检测器（complexity-detector.ts）
 *
 * 纯静态分析源码复杂度（零网络、零执行）：
 * - nested-loop：三层以上嵌套循环（For/While/DoWhile）→ medium
 * - sync-io：同步阻塞 IO 调用（readFileSync 等）→ high
 *
 * 文件缺失 / 目录不存在均按静默跳过处理，不抛异常。
 */
import * as fs from 'fs';
import * as path from 'path';
import { safeJoin } from '@zh/shared';
import { DEFAULT_CONFIG, type PerformanceConfig, type PerformanceIssue } from '../types';
import {
  resolveSourceRoots,
  collectFilesAcrossRoots,
  NON_PRODUCTION_DIRS,
  isNonProductionFile,
} from '../source-roots';

const SOURCE_EXTS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx'];
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', 'build', 'out']);
const NESTED_LOOP_THRESHOLD = 3;
const SYNC_IO_PATTERN = /\b(readFileSync|writeFileSync|appendFileSync|execSync|spawnSync)\s*\(/g;

export interface ComplexityDetector {
  detect(projectRoot: string, config?: PerformanceConfig): PerformanceIssue[];
}

function readTextSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 去除 JS/TS 注释与字符串字面量，保留空白/换行以维持位置对齐。
 * 简单词法清洗，非完整解析器。
 */
function stripCommentsAndStrings(source: string): string {
  let result = '';
  let i = 0;
  while (i < source.length) {
    if (source[i] === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      result += '\n';
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      result += '  ';
      continue;
    }
    if (source[i] === '"' || source[i] === "'" || source[i] === '`') {
      const quote = source[i];
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      result += '  ';
      continue;
    }
    result += source[i];
    i++;
  }
  return result;
}

/**
 * 词法扫描：返回源码中最深的循环嵌套层数。
 * 算法：遍历 token（loop 关键字 / 花括号），跟踪循环体进入的花括号深度，
 * 当 `}` 回退时弹出已结束的循环体，实时维护当前嵌套层数。
 */
function detectMaxLoopDepth(source: string): number {
  const stripped = stripCommentsAndStrings(source);
  let braceDepth = 0;
  let expectLoopBody = false;
  const loopBodyDepths: number[] = [];
  let maxNesting = 0;

  const tokens = stripped.matchAll(/\b(for|while|do)\b|\{|\}/g);
  for (const match of tokens) {
    const token = match[0];
    if (token === '{') {
      braceDepth++;
      if (expectLoopBody) {
        loopBodyDepths.push(braceDepth);
        if (loopBodyDepths.length > maxNesting) {
          maxNesting = loopBodyDepths.length;
        }
        expectLoopBody = false;
      }
    } else if (token === '}') {
      braceDepth--;
      while (loopBodyDepths.length > 0 && loopBodyDepths[loopBodyDepths.length - 1] > braceDepth) {
        loopBodyDepths.pop();
      }
    } else {
      expectLoopBody = true;
    }
  }
  return maxNesting;
}

export class ComplexityDetectorImpl implements ComplexityDetector {
  detect(projectRoot: string, config?: PerformanceConfig): PerformanceIssue[] {
    const cfg: PerformanceConfig = { ...DEFAULT_CONFIG, ...(config ?? {}) };
    const issues: PerformanceIssue[] = [];
    const files = collectFilesAcrossRoots(
      resolveSourceRoots(projectRoot),
      collectSourceFiles,
      cfg.scanLimit,
    );

    for (const filePath of files) {
      const content = readTextSafe(filePath);
      if (content === null) continue;
      const rel = path.relative(projectRoot, filePath).split(path.sep).join('/');
      this.detectNestedLoop(rel, content, issues);
      this.detectSyncIO(rel, content, issues);
    }
    return issues;
  }

  private detectNestedLoop(relFile: string, content: string, issues: PerformanceIssue[]): void {
    const maxDepth = detectMaxLoopDepth(content);
    if (maxDepth >= NESTED_LOOP_THRESHOLD) {
      issues.push({
        id: `complexity-nested-loop-${relFile}`,
        ruleId: 'complexity.nested-loop',
        category: 'complexity',
        severity: 'medium',
        file: relFile,
        message: `${relFile} 存在 ${maxDepth} 层嵌套循环 — 时间复杂度为 O(n^${maxDepth})，严重影响性能`,
        suggestion: '将内层循环提取为独立函数，或使用 Map/Set 降低嵌套层级',
        autoFixable: false,
      });
    }
  }

  private detectSyncIO(relFile: string, content: string, issues: PerformanceIssue[]): void {
    const stripped = stripCommentsAndStrings(content);
    const seen = new Set<string>();
    const re = new RegExp(SYNC_IO_PATTERN.source, SYNC_IO_PATTERN.flags);
    for (const m of stripped.matchAll(re)) {
      const fnName = m[1];
      if (seen.has(fnName)) continue;
      seen.add(fnName);
      issues.push({
        id: `complexity-sync-io-${relFile}-${fnName}`,
        ruleId: 'complexity.sync-io',
        category: 'complexity',
        severity: 'high',
        file: relFile,
        message: `${relFile} 调用了 ${fnName}() — 同步阻塞主线程，影响页面响应`,
        suggestion: `将 ${fnName}() 替换为异步版本（如 readFile / writeFile），或移至 Worker 线程`,
        autoFixable: false,
      });
    }
  }
}

function collectSourceFiles(dir: string, limit: number): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  const visit = (current: string): void => {
    if (files.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      if (files.length >= limit) return;
      const full = safeJoin(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || NON_PRODUCTION_DIRS.has(entry.name)) continue;
        visit(full);
      } else if (
        entry.isFile() &&
        SOURCE_EXTS.includes(path.extname(entry.name)) &&
        !isNonProductionFile(entry.name)
      ) {
        files.push(full);
      }
    }
  };
  visit(dir);
  return files;
}

export const complexityDetector: ComplexityDetector = new ComplexityDetectorImpl();
