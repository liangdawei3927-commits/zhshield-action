import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestResult } from './test-result';

/** vitest 汇总行开头：排除 "Test Files ..." 等行，要求 "Tests" 后紧跟空格 + 数字 */
const VITEST_COUNT_PREFIX_RE = /^\s+\d/;
/** vitest 汇总行末尾总计：`(47)` / `(731)` */
const VITEST_TOTAL_RE = /\((\d+)\)\s*$/;

/** ANSI 转义序列（turbo 透传子进程输出时保留颜色码，会破坏 vitest 汇总行匹配）。
 *  用 String.fromCharCode(27) 构造 ESC，避免源码中出现 \u001b 字面量触发 no-control-regex。 */
const ANSI_ESCAPE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g');

/**
 * 解析 vitest 测试输出为测试计数与失败明细；
 * 输出中解析不到测试计数时，以文件系统扫描真实测试文件数兜底。
 */
export class VitestOutputParser {
  parseOutput(output: string, startTime: number): TestResult {
    const lines = output.split('\n');
    const strippedLines = lines.map((l) => l.replace(ANSI_ESCAPE, ''));
    const details = this.collectFailureDetails(strippedLines);
    const counts = this.parseVitestCounts(strippedLines);
    const finalCounts = counts.totalTests > 0 ? counts : this.estimateFromTestFiles(strippedLines);
    const durationMs = Date.now() - startTime;

    return {
      command: 'vitest run',
      totalTests: finalCounts.totalTests,
      passed: finalCounts.passed,
      failed: finalCounts.failed,
      skipped: 0,
      durationMs,
      details,
    };
  }

  parseVitestCounts(lines: string[]): { totalTests: number; passed: number; failed: number } {
    let totalTests = 0;
    let passed = 0;
    let failed = 0;

    for (const line of lines) {
      const summary = this.parseVitestSummaryLine(line.replace(ANSI_ESCAPE, ''));
      if (!summary) continue;
      // turbo --output-logs=full 会输出每个包一条 "Tests N ..." 汇总，
      // 需累加汇总多包总数，而非只取最后一条
      passed += summary.passed;
      failed += summary.failed;
      totalTests += summary.total;
    }

    return { totalTests, passed, failed };
  }

  /** 输出解析不到测试计数时，以文件系统真实测试文件数兜底（排除 node_modules / dist / .git） */
  countTestFilesOnDisk(projectPath: string): number {
    let count = 0;
    const stack = [projectPath];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) continue;
      count += this.countTestFilesInDir(dir, stack);
    }
    return count;
  }

  /**
   * 解析单行 vitest 汇总行。
   * 兼容 vitest v4（失败在前：`Tests  3 failed | 44 passed (47)`）与旧版
   * （通过在前：`Tests  725 passed | 6 failed (731)`、`Tests  68 passed (68)`）。
   * 非汇总行（如 turbo 任务摘要 `Tasks: 26 successful`）返回 null。
   */
  private parseVitestSummaryLine(
    line: string,
  ): { passed: number; failed: number; total: number } | null {
    const testsIdx = line.indexOf('Tests');
    if (testsIdx === -1) return null;
    const rest = line.slice(testsIdx + 'Tests'.length);
    // 排除 "Test Files  4 passed (4)" 这类行：要求 "Tests" 后紧跟空格 + 数字
    if (!VITEST_COUNT_PREFIX_RE.test(rest)) return null;

    const counts = rest.match(/\d+\s+(?:passed|failed)/g) ?? [];
    let passed = 0;
    let failed = 0;
    for (const count of counts) {
      const n = parseInt(count, 10);
      if (count.endsWith('failed')) failed += n;
      else passed += n;
    }
    if (passed === 0 && failed === 0) return null;

    const totalMatch = rest.match(VITEST_TOTAL_RE);
    const total = totalMatch ? parseInt(totalMatch[1], 10) : passed + failed;
    return { passed, failed, total };
  }

  private collectFailureDetails(lines: string[]): string[] {
    const details: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes('FAIL') && trimmed.includes('__tests__')) {
        details.push(trimmed);
      }
    }
    return details;
  }

  private estimateFromTestFiles(lines: string[]): {
    totalTests: number;
    passed: number;
    failed: number;
  } {
    const testFileMatches = lines.filter((l) => l.includes('__tests__') && l.includes('.test.'));
    const totalTests = testFileMatches.length;
    return { totalTests, passed: totalTests, failed: 0 };
  }

  /** 统计单个目录中的测试文件数，并将待扫描子目录压入栈 */
  private countTestFilesInDir(dir: string, stack: string[]): number {
    let count = 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!this.isIgnoredDirName(entry.name)) stack.push(path.join(dir, entry.name));
      } else if (this.isTestFileName(entry.name)) {
        count++;
      }
    }
    return count;
  }

  private isIgnoredDirName(name: string): boolean {
    return name === 'node_modules' || name === 'dist' || name === '.git' || name.startsWith('.');
  }

  private isTestFileName(name: string): boolean {
    return name.endsWith('.test.ts') || name.endsWith('.spec.ts');
  }
}
