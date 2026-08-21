import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue } from '@zh/shared';

const execFileAsync = promisify(execFile);

const META: Omit<ToolMeta, 'description'> = {
  id: 'ts-prune',
  name: 'ts-prune',
  category: 'inspect',
  priority: 'P1',
  installMode: 'builtin',
  cliCommand: 'ts-prune',
  homepage: 'https://github.com/nadeesha/ts-prune',
  license: 'MIT',
};

const TS_PRUNE_LINE = /^(.+?):(\d+):\s*(.+)$/;

export class TsPruneAdapter implements ToolAdapter {
  meta: ToolMeta;
  private readonly locale: LanguageCode;

  constructor(locale?: LanguageCode) {
    this.locale = locale ?? DEFAULT_LANGUAGE;
    this.meta = { ...META, description: translate('engine.inspect.tool.ts-prune.description', this.locale) };
  }

  private tr(key: string, params?: Record<string, unknown>): string {
    return translate(key, this.locale, params);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('ts-prune', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const tsConfigPath = path.join(options.projectPath, 'tsconfig.json');

    try {
      const stdout = await this.runTsPrune(tsConfigPath, options);
      const issues = this.mapOutput(stdout);
      return this.buildAvailable(start, issues);
    } catch (error: unknown) {
      return this.buildErrorResult(start, error);
    }
  }

  private async runTsPrune(tsConfigPath: string, options: ToolScanOptions): Promise<string> {
    const { stdout } = await execFileAsync('ts-prune', [
      '-p', tsConfigPath,
      '--json',
    ], {
      cwd: options.projectPath,
      timeout: options.timeout || 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  private buildAvailable(start: number, issues: Issue[]): ToolResult {
    return {
      tool: 'ts-prune',
      status: 'available',
      issues,
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: issues.length,
      },
    };
  }

  private buildErrorResult(start: number, error: unknown): ToolResult {
    const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return {
        tool: 'ts-prune',
        status: 'unavailable',
        issues: [],
        metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
        error: this.tr('engine.inspect.tool.ts-prune.unavailable'),
      };
    }
    if (err.stdout) {
      const issues = this.mapOutput(err.stdout, this.locale);
      if (issues.length > 0) {
        return this.buildAvailable(start, issues);
      }
    }
    return {
      tool: 'ts-prune',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error: err.stderr || err.message || this.tr('engine.inspect.tool.ts-prune.runFailed'),
    };
  }

  private mapOutput(raw: string, locale?: LanguageCode): Issue[] {
    if (!raw || !raw.trim()) return [];
    const lng = locale ?? DEFAULT_LANGUAGE;
    const lines = raw.trim().split('\n');
    const issues: Issue[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const match = trimmed.match(TS_PRUNE_LINE);
      if (match) {
        const [, filePath, lineStr, symbol] = match;
        const symbolName = symbol.trim();
        issues.push({
          id: randomUUID(),
          ruleId: 'ts-prune/unused-export',
          severity: 'info',
          category: 'quality',
          message: translate('engine.inspect.tool.ts-prune.unusedExport', lng, { symbol: symbolName }),
          file: filePath,
          line: parseInt(lineStr, 10) || 0,
          column: 0,
          suggestion: translate('engine.inspect.tool.ts-prune.removeExport', lng, { symbol: symbolName }),
          autoFixable: false,
          source: 'inspect',
          fingerprint: `ts-prune:${filePath}:${lineStr}:${symbolName}`,
        });
      }
    }

    return issues;
  }
}
