import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue, IssueCategory } from '@zh/shared';

const execFileAsync = promisify(execFile);

const META: ToolMeta = {
  id: 'semgrep',
  name: 'Semgrep',
  category: 'inspect',
  priority: 'P0',
  installMode: 'builtin',
  description: 'SAST 代码漏洞扫描（SQL 注入、XSS、CSRF、命令注入、路径遍历等）',
  cliCommand: 'semgrep',
  homepage: 'https://semgrep.dev',
  license: 'LGPL-2.1',
};

/** Semgrep JSON 输出中的单条结果 */
interface SemgrepResult {
  check_id?: string;
  rule?: { id?: string };
  severity?: string;
  path?: string;
  start?: { line?: number; col?: number; column?: number };
  extra?: {
    severity?: string;
    message?: string;
    fix?: string;
    metadata?: { fix?: string };
  };
  message?: string;
}

/** Semgrep JSON 输出中的单条错误 */
interface SemgrepErrorEntry {
  code?: number | string;
  level?: string;
  type?: string;
  message?: string;
}

/** Semgrep JSON 输出结构 */
interface SemgrepOutput {
  results?: SemgrepResult[];
  errors?: SemgrepErrorEntry[];
}

/** 本机 semgrep-core（OCaml 运行时）每次启动都会打印的无害告警，非扫描失败原因 */
const RUNTIME_NOISE_PATTERNS: readonly RegExp[] = [
  /Failed to register segfault signal handler/,
  /Failed to register unwind handler/,
];

/** 内联规则声明（来自 config.rules，原始声明为 string[]，此处按对象结构访问） */
interface SemgrepRule {
  id?: string;
  severity?: string;
  language?: string;
  languages?: string[];
  pattern?: string;
  message?: string;
}

/** 规范化后用于生成 YAML 的规则 */
interface SemgrepRuleYaml {
  id: string;
  severity: string;
  languages: string[];
  pattern?: string;
  message: string;
}

export class SemgrepAdapter implements ToolAdapter {
  meta = META;

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('semgrep', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const targetDir = options.targetFiles?.[0] ?? this.resolveTargetDir(options.projectPath);
    const category: IssueCategory = options.config?.category ?? 'security';

    const configs = this.resolveConfigs(options);
    const rules = options.config?.rules as unknown as SemgrepRule[] | undefined;

    const args: string[] = [
      'scan',
      '--json',
      '--optimizations', 'all',
    ];

    for (const c of configs) {
      args.push('--config', c);
    }

    if (rules && rules.length > 0) {
      const rulePath = await this.writeInlineRules(targetDir, rules);
      if (rulePath) args.push('--config', rulePath);
    }

    args.push(targetDir);

    try {
      const { stdout } = await execFileAsync('semgrep', args, {
        cwd: options.projectPath,
        timeout: options.timeout || 120000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const output = JSON.parse(stdout);
      return this.buildAvailable(output, this.mapOutput(output, category), start);
    } catch (error: unknown) {
      const err = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      if (err.code === 'ENOENT') {
        return this.buildUnavailable(start, 'Semgrep 未安装或未在 PATH 中找到');
      }
      if (err.code === 'ETIMEDOUT') {
        return this.buildError(start, 'Semgrep 扫描超时');
      }

      // 优先报告 JSON errors 中的真实错误，而非 OCaml 运行时噪音
      const jsonError = this.extractJsonError(err.stdout);
      if (jsonError) {
        return this.buildError(start, jsonError);
      }

      // semgrep 存在 findings 时退出码为 1；stdout 仍为有效 JSON
      const partial = this.parsePartialOutput(err.stdout ?? '', category, err.stderr);
      if (partial) {
        return this.buildAvailable(partial.output, partial.issues, start);
      }

      // 兜底：剔除 OCaml 运行时噪音后使用 stderr / message
      return this.buildError(start, this.stripRuntimeNoise(err.stderr) || err.message || 'Semgrep 执行失败');
    }
  }

  /** 目标目录解析：src → packages → 项目根；容器根项目下探嵌套代码仓库的 packages 目录，避免全量扫描 */
  private resolveTargetDir(projectPath: string): string {
    const srcDir = path.join(projectPath, 'src');
    if (fs.existsSync(srcDir)) return srcDir;
    const packagesDir = path.join(projectPath, 'packages');
    if (fs.existsSync(packagesDir)) return packagesDir;

    try {
      for (const entry of fs.readdirSync(projectPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const child = path.join(projectPath, entry.name);
        if (fs.existsSync(path.join(child, 'package.json')) && fs.existsSync(path.join(child, 'packages'))) {
          return path.join(child, 'packages');
        }
      }
    } catch {
      // 目录读取失败则回退项目根
    }
    return projectPath;
  }

  private extractJsonError(stdout?: string): string | null {
    if (!stdout) return null;
    try {
      const output = JSON.parse(stdout) as SemgrepOutput;
      const first = output.errors?.find((e) => typeof e.message === 'string' && e.message.length > 0);
      return first?.message ?? null;
    } catch {
      return null;
    }
  }

  private stripRuntimeNoise(stderr?: string): string {
    if (!stderr) return '';
    return stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !RUNTIME_NOISE_PATTERNS.some((pattern) => pattern.test(line)))
      .join('\n');
  }

  private parsePartialOutput(
    stdout: string,
    category: IssueCategory,
    stderr?: string,
  ): { output: SemgrepOutput; issues: Issue[] } | null {
    if (!stdout) return null;
    try {
      const output = JSON.parse(stdout);
      const issues = this.mapOutput(output, category);
      if (issues.length > 0 || !stderr) {
        return { output, issues };
      }
    } catch {
      return null;
    }
    return null;
  }

  private buildAvailable(output: SemgrepOutput, issues: Issue[], start: number): ToolResult {
    return {
      tool: 'semgrep',
      status: 'available',
      issues,
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: Array.isArray(output.results) ? output.results.length : 0,
      },
    };
  }

  private buildUnavailable(start: number, error: string): ToolResult {
    return {
      tool: 'semgrep',
      status: 'unavailable',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error,
    };
  }

  private buildError(start: number, error: string): ToolResult {
    return {
      tool: 'semgrep',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error,
    };
  }

  private resolveConfigs(options: ToolScanOptions): string[] {
    const cfgs = options.config?.config;
    if (!cfgs) return [];
    if (Array.isArray(cfgs)) return cfgs as string[];
    if (typeof cfgs === 'string') return [cfgs];
    return [];
  }

  private async writeInlineRules(targetDir: string, rules: SemgrepRule[]): Promise<string | null> {
    if (rules.length === 0) return null;

    const semgrepRules: SemgrepRuleYaml[] = rules.map((r, i) => ({
      id: r.id || `inline-rule-${i}`,
      severity: (r.severity || 'WARNING').toUpperCase(),
      languages: this.detectLanguages(r),
      pattern: r.pattern,
      message: r.message || `Semgrep: ${r.id || `rule-${i}`}`,
    }));

    const ruleDir = path.join(targetDir, '.semgrep');
    try {
      await fs.promises.mkdir(ruleDir, { recursive: true });
      const rulePath = path.join(ruleDir, `inline-${Date.now()}.yml`);
      const yamlContent = this.buildRuleYaml(semgrepRules);
      await fs.promises.writeFile(rulePath, yamlContent, 'utf-8');
      return rulePath;
    } catch {
      return null;
    }
  }

  private detectLanguages(rule: SemgrepRule): string[] {
    if (rule.language) return [rule.language];
    if (rule.languages) return rule.languages;
    return ['typescript'];
  }

  private buildRuleYaml(rules: SemgrepRuleYaml[]): string {
    const lines: string[] = ['rules:'];
    for (const r of rules) {
      lines.push(`  - id: ${r.id}`);
      lines.push(`    severity: ${r.severity}`);
      lines.push(`    languages: [${r.languages.join(', ')}]`);
      lines.push(`    message: ${r.message}`);
      lines.push(`    pattern: |`);
      for (const line of (r.pattern || '').split('\n')) {
        lines.push(`      ${line}`);
      }
    }
    return lines.join('\n');
  }

  private mapOutput(output: SemgrepOutput, category: IssueCategory = 'security'): Issue[] {
    const results = output?.results;
    if (!Array.isArray(results)) return [];

    return results.map((r) => this.mapResult(r, category));
  }

  private mapResult(r: SemgrepResult, category: IssueCategory): Issue {
    const ruleId = this.resolveRuleId(r);
    const fix = this.resolveFix(r);
    const loc = this.resolveLocation(r);

    return {
      id: randomUUID(),
      ruleId,
      severity: this.normalizeSeverity(r.extra?.severity || r.severity || 'WARNING'),
      category,
      message: this.resolveMessage(r, ruleId),
      file: loc.file,
      line: loc.line,
      column: loc.column,
      suggestion: fix,
      autoFixable: !!fix,
      source: 'inspect',
      fingerprint: this.resolveFingerprint(ruleId, loc),
    };
  }

  private resolveRuleId(r: SemgrepResult): string {
    return r.check_id || r.rule?.id || 'semgrep-unknown';
  }

  private resolveFix(r: SemgrepResult): string | undefined {
    return r.extra?.fix || r.extra?.metadata?.fix || undefined;
  }

  private resolveMessage(r: SemgrepResult, ruleId: string): string {
    return r.extra?.message || r.message || `Semgrep: ${ruleId}`;
  }

  private resolveLocation(r: SemgrepResult): { file: string; line: number; column: number } {
    return {
      file: r.path || '',
      line: r.start?.line || 0,
      column: r.start?.col || r.start?.column || 0,
    };
  }

  private resolveFingerprint(ruleId: string, loc: { file: string; line: number }): string {
    return `semgrep:${ruleId}:${loc.file}:${loc.line}`;
  }

  private normalizeSeverity(sev: string): 'error' | 'warning' | 'info' {
    const lower = sev.toLowerCase();
    return lower === 'error' ? 'error' : lower === 'warning' ? 'warning' : 'info';
  }
}
