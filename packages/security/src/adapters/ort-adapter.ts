import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { sanitizeEnv } from '@zh/shared';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue } from '@zh/shared';
import type { ExecError } from './tool-output-types';

const execFileAsync = promisify(execFile);
const ORT_TIMEOUT = 300000; // 5 min

/** 需关注/标记的许可证 */
const RESTRICTED_LICENSES = new Set([
  'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'AGPL-3.0-only', 'AGPL-3.0-or-later',
  'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'BUSL-1.1', 'SSPL-1.0', 'BSL-1.0',
  'No-license-found',
]);

const META: ToolMeta = {
  id: 'ort',
  name: 'ORT',
  category: 'security',
  priority: 'P0',
  installMode: 'on-demand',
  description: '许可证合规扫描',
  cliCommand: 'ort',
  homepage: 'https://github.com/oss-review-toolkit/ort',
  license: 'Apache-2.0',
};

interface OrtPackageEntry {
  id: string;
  declared_licenses: string[];
  description?: string;
  homepage_url?: string;
}

interface OrtAnalyzerResult {
  analyzer?: {
    result?: {
      packages?: OrtPackageEntry[];
    };
  };
}

interface OrtParseState {
  currentPkg: Record<string, unknown> | null;
  inPackages: boolean;
  indentDepth: number;
}

export class ORTAdapter implements ToolAdapter {
  meta = META;

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('ort', ['--version'], { timeout: 10000, env: sanitizeEnv() });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const outputDir = path.join(options.projectPath, '.zhshield', '.ort-output');

    try {
      const issues = await this.runOrtScan(options, outputDir);
      return {
        tool: 'ort',
        status: 'available',
        issues,
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: issues.length,
        },
      };
    } catch (error) {
      return this.buildErrorResult(start, error as ExecError, outputDir);
    }
  }

  private async runOrtScan(options: ToolScanOptions, outputDir: string): Promise<Issue[]> {
    await fs.promises.mkdir(outputDir, { recursive: true });
    const pm = options.config?.packageManagers?.[0] || 'NPM';

    try {
      await this.runOrtAnalyze(options, outputDir, pm);
      return await this.readAnalyzerResult(outputDir);
    } finally {
      await fs.promises.rm(outputDir, { recursive: true, force: true }).catch(() => { /* ignore cleanup failure */ });
    }
  }

  private async runOrtAnalyze(options: ToolScanOptions, outputDir: string, pm: string): Promise<void> {
    await execFileAsync('ort', [
      'analyze',
      '-i', options.projectPath,
      '-o', outputDir,
      '--package-managers', pm,
    ], {
      cwd: options.projectPath,
      timeout: options.timeout || ORT_TIMEOUT,
      maxBuffer: 50 * 1024 * 1024,
      env: sanitizeEnv(),
    });
  }

  private async readAnalyzerResult(outputDir: string): Promise<Issue[]> {
    const resultFile = path.join(outputDir, 'analyzer-result.yml');
    let issues: Issue[] = [];

    if (fs.existsSync(resultFile)) {
      const content = await fs.promises.readFile(resultFile, 'utf-8');
      issues = this.mapOutput(content);
    }

    return issues;
  }

  private async buildErrorResult(start: number, err: ExecError, outputDir: string): Promise<ToolResult> {
    await fs.promises.rm(outputDir, { recursive: true, force: true }).catch(() => { /* ignore */ });

    if (err.code === 'ENOENT') {
      return {
        tool: 'ort',
        status: 'unavailable',
        issues: [],
        metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
        error: 'ORT 未安装',
      };
    }
    return {
      tool: 'ort',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error: err.stderr || err.message || 'ORT 执行失败',
    };
  }

  private mapOutput(yamlContent: string): Issue[] {
    const parsed = this.parseOrtYaml(yamlContent);
    if (!parsed) return [];
    return this.collectRestrictedLicenseIssues(parsed.analyzer?.result?.packages);
  }

  private collectRestrictedLicenseIssues(packages: OrtPackageEntry[] | undefined): Issue[] {
    if (!packages || !Array.isArray(packages)) return [];

    const issues: Issue[] = [];
    for (const pkg of packages) {
      const licenses = pkg.declared_licenses || [];
      const restrictedLicenses = licenses.filter((l) => RESTRICTED_LICENSES.has(l));
      if (restrictedLicenses.length === 0) continue;
      issues.push(this.buildLicenseIssue(pkg, restrictedLicenses));
    }
    return issues;
  }

  private buildLicenseIssue(pkg: OrtPackageEntry, restrictedLicenses: string[]): Issue {
    return {
      id: randomUUID(),
      ruleId: 'ort/restricted-license',
      severity: restrictedLicenses.some((l) => l.startsWith('GPL') || l.startsWith('AGPL'))
        ? 'error' : 'warning',
      category: 'dependency',
      message: `${pkg.id || 'unknown'} 使用了需要关注的许可证: ${restrictedLicenses.join(', ')}`,
      file: '',
      line: 0,
      column: 0,
      suggestion: `评估 ${pkg.id || 'unknown'} 的许可证 ${restrictedLicenses.join(', ')} 是否与项目兼容`,
      autoFixable: false,
      source: 'security',
      fingerprint: `ort:license:${pkg.id || 'unknown'}`,
    };
  }

  /**
   * 简化版 YAML 解析器 — 提取 analyzer.result.packages 数组
   */
  private parseOrtYaml(content: string): OrtAnalyzerResult | null {
    try {
      const lines = content.split('\n');
      const packages: OrtPackageEntry[] = [];
      const state: OrtParseState = { currentPkg: null, inPackages: false, indentDepth: 0 };
      for (const line of lines) {
        this.parseOrtLine(line, lines, packages, state);
      }
      return this.buildAnalyzerResult(packages, state);
    } catch {
      return null;
    }
  }

  private buildAnalyzerResult(packages: OrtPackageEntry[], state: OrtParseState): OrtAnalyzerResult | null {
    if (state.currentPkg) {
      packages.push(state.currentPkg as unknown as OrtPackageEntry);
    }
    if (packages.length === 0) return null;
    return { analyzer: { result: { packages } } };
  }

  private parseOrtLine(
    line: string,
    lines: string[],
    packages: OrtPackageEntry[],
    state: OrtParseState,
  ): void {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.trimStart().startsWith('#')) return;
    const indent = trimmed.length - trimmed.trimStart().length;

    if (this.isPackageStartLine(trimmed)) {
      this.openPackageEntry(packages, state, trimmed, indent);
      return;
    }

    if (state.inPackages && state.currentPkg && indent > state.indentDepth) {
      this.parsePackageField(state.currentPkg, line, lines, indent);
      return;
    }

    if (state.inPackages && indent <= state.indentDepth) {
      this.closePackageEntry(packages, state);
    }
  }

  private openPackageEntry(
    packages: OrtPackageEntry[],
    state: OrtParseState,
    trimmed: string,
    indent: number,
  ): void {
    state.currentPkg = this.openPackage(packages, state.currentPkg, trimmed);
    state.inPackages = true;
    state.indentDepth = indent;
  }

  private closePackageEntry(packages: OrtPackageEntry[], state: OrtParseState): void {
    if (state.currentPkg) {
      packages.push(state.currentPkg as unknown as OrtPackageEntry);
    }
    state.currentPkg = null;
    state.inPackages = false;
  }

  private isPackageStartLine(trimmed: string): boolean {
    return trimmed.trimStart().startsWith('- id:');
  }

  private openPackage(
    packages: OrtPackageEntry[],
    currentPkg: Record<string, unknown> | null,
    trimmed: string,
  ): Record<string, unknown> {
    if (currentPkg) {
      packages.push(currentPkg as unknown as OrtPackageEntry);
    }
    return { id: trimmed.trimStart().slice(5).trim().replace(/['"]/g, '') };
  }

  private parsePackageField(
    currentPkg: Record<string, unknown>,
    line: string,
    lines: string[],
    indent: number,
  ): void {
    const content = line.trimEnd().trimStart();
    const colonIdx = content.indexOf(':');
    if (colonIdx === -1) return;
    const key = content.slice(0, colonIdx).trim();
    const val = content.slice(colonIdx + 1).trim();

    if (key === 'declared_licenses') {
      currentPkg.declared_licenses = this.collectLicenseLines(lines, lines.indexOf(line) + 1, indent);
    } else if (key === 'description') {
      currentPkg.description = val.replace(/['"]/g, '');
    } else if (key === 'homepage_url') {
      currentPkg.homepage_url = val.replace(/['"]/g, '');
    }
  }

  private collectLicenseLines(lines: string[], startLine: number, indent: number): string[] {
    const licenseLines: string[] = [];
    let i = startLine;
    while (i < lines.length) {
      const nextLine = lines[i].trimEnd();
      const nextIndent = nextLine.length - nextLine.trimStart().length;
      if (nextIndent <= indent + 2) break;
      if (nextLine.trimStart().startsWith('- ')) {
        licenseLines.push(nextLine.trimStart().slice(2).trim().replace(/['"]/g, ''));
      }
      i++;
    }
    return licenseLines;
  }
}
