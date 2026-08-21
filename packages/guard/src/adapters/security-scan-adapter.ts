import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Adapter, CheckConfig, CheckResult, CheckStatus } from '../types';

interface Finding {
  file: string;
  line: number;
  type: string;
  severity: 'high' | 'medium' | 'low';
  message: string;
}

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git', '.turbo', '.next', 'build', 'coverage', '.nyc_output']);

/**
 * Built-in security patterns for static analysis.
 * Each pattern checks for common vulnerabilities in source code.
 */
const SECURITY_PATTERNS: { type: string; severity: 'high' | 'medium' | 'low'; regex: RegExp; message: string }[] = [
  { type: 'sql-injection',     severity: 'high',   regex: /\.exec(?:ute)?\s*\(\s*[`'"].*\${\s*\w+\s*}/i,   message: '可能的 SQL 注入: 使用了字符串拼接而非参数化查询' },
  { type: 'eval-usage',        severity: 'high',   regex: /\beval\s*\(/,                                    message: '避免使用 eval(): 可能导致代码注入' },
  { type: 'command-injection', severity: 'high',   regex: /(?:exec|execSync|spawn)\s*\(\s*[`'"]/,            message: '可能的命令注入: 使用 execFile 替代 exec' },
  { type: 'no-new-func',       severity: 'high',   regex: /new\s+Function\s*\(/,                            message: '避免 new Function(): 可能导致代码注入' },

  { type: 'inner-html',        severity: 'medium', regex: /\.innerHTML\s*=/,                                message: '使用 innerHTML 可能导致 XSS, 优先使用 textContent' },
  { type: 'console-log',       severity: 'low',    regex: /console\.\w+\s*\(/,                              message: '生产环境应移除 console 语句' },
  { type: 'todo-fixme',        severity: 'low',    regex: /\/\/\s*(TODO|FIXME|HACK|XXX)\b/,                message: '存在未处理的代办事项 (TODO/FIXME)' },
  { type: 'debugger',          severity: 'medium', regex: /\bdebugger\s*;?$/,                              message: '生产环境应移除 debugger 语句' },

  { type: 'hardcoded-port',    severity: 'low',    regex: /(?:port|PORT)\s*[:=]\s*\d{4,5}\b/,              message: '检查硬编码端口号是否应改为配置项' },
];

const ALLOWED_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return files; }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      files.push(...collectFiles(fullPath));
      continue;
    }
    if (ALLOWED_EXTENSIONS.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

export class SecurityScanAdapter implements Adapter {
  run(
    context: { repoRoot?: string; projectPath?: string },
    _check: CheckConfig,
  ): { findings: Finding[]; error?: string } {
    const targetDir = context.repoRoot || context.projectPath || process.cwd();
    const findings: Finding[] = [];

    try {
      this.scanProject(targetDir, findings);
    } catch (error: unknown) {
      return { findings: [], error: error instanceof Error ? error.message : String(error) };
    }

    return { findings };
  }

  /** 扫描项目的源码目录（无 src 时回退到项目根） */
  private scanProject(targetDir: string, findings: Finding[]): void {
    const srcDir = path.join(targetDir, 'src');
    const scanRoot = fs.existsSync(srcDir) ? srcDir : targetDir;
    const files = collectFiles(scanRoot);

    for (const file of files) {
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch { continue; }
      this.scanContent(content, path.relative(targetDir, file), findings);
    }
  }

  private scanContent(content: string, relFile: string, findings: Finding[]): void {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const pattern = this.findPatternMatch(lines[i]);
      if (!pattern) continue;
      findings.push({
        file: relFile,
        line: i + 1,
        type: pattern.type,
        severity: pattern.severity,
        message: pattern.message,
      });
    }
  }

  private findPatternMatch(line: string): { type: string; severity: 'high' | 'medium' | 'low'; message: string } | null {
    for (const pattern of SECURITY_PATTERNS) {
      if (pattern.regex.test(line)) return pattern;
    }
    return null;
  }

  normalize(
    rawResult: { findings: Finding[]; error?: string },
    _context: unknown,
    check: CheckConfig,
  ): CheckResult {
    if (rawResult.error) {
      return this.makeResult(check, 'error', `安全扫描失败: ${rawResult.error}`);
    }
    return this.buildFindingsResult(check, rawResult.findings);
  }

  /** 汇总各严重级别统计并构建安全扫描检查结果 */
  private buildFindingsResult(check: CheckConfig, findings: Finding[]): CheckResult {
    if (findings.length === 0) {
      return this.makeResult(check, 'passed', '安全扫描通过，未发现明显安全问题');
    }

    const highCount = findings.filter(f => f.severity === 'high').length;
    const medCount = findings.filter(f => f.severity === 'medium').length;
    const lowCount = findings.filter(f => f.severity === 'low').length;

    const details = findings.map(f =>
      `[${f.severity}] ${f.file}:${f.line} ${f.message}`
    );

    const status: CheckStatus = highCount > 0 ? 'failed' : 'warning';
    return this.makeResult(
      check,
      status,
      `发现 ${findings.length} 个安全问题 (高危 ${highCount}, 中危 ${medCount}, 低危 ${lowCount}):\n${details.join('\n')}`,
      { findings, count: findings.length, highCount, mediumCount: medCount, lowCount },
    );
  }

  private makeResult(check: CheckConfig, status: CheckStatus, message: string, details?: unknown): CheckResult {
    return {
      checkId: check.checkId,
      adapter: check.adapter,
      status,
      severity: status === 'failed' || status === 'error' ? check.severity : 'info',
      blocking: check.blocking && (status === 'failed' || status === 'error'),
      message,
      details,
    };
  }
}
