import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue } from '@zh/shared';

const execFileAsync = promisify(execFile);

const META: Omit<ToolMeta, 'description'> = {
  id: 'depcheck',
  name: 'Depcheck',
  category: 'inspect',
  priority: 'P1',
  installMode: 'builtin',
  cliCommand: 'depcheck',
  homepage: 'https://github.com/depcheck/depcheck',
  license: 'MIT',
};

interface DepcheckResult {
  dependencies: string[];
  devDependencies: string[];
  missing: Record<string, string[]>;
  using: Record<string, string[]>;
}

export class DepcheckAdapter implements ToolAdapter {
  meta: ToolMeta;
  private readonly locale: LanguageCode;

  constructor(locale?: LanguageCode) {
    this.locale = locale ?? DEFAULT_LANGUAGE;
    this.meta = { ...META, description: translate('engine.inspect.tool.depcheck.description', this.locale) };
  }

  private tr(key: string, params?: Record<string, unknown>): string {
    return translate(key, this.locale, params);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('depcheck', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const projectPath = options.projectPath;

    try {
      const stdout = await this.runDepcheck(projectPath, options);
      const result: DepcheckResult = JSON.parse(stdout);
      const issues = this.mapOutput(result, projectPath, this.locale);
      return this.buildAvailable(start, issues);
    } catch (error: unknown) {
      return this.buildErrorResult(start, error);
    }
  }

  private async runDepcheck(projectPath: string, options: ToolScanOptions): Promise<string> {
    const args = this.buildArgs(projectPath, options);
    const { stdout } = await execFileAsync('depcheck', args, {
      cwd: projectPath,
      timeout: options.timeout || 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  private buildArgs(projectPath: string, options: ToolScanOptions): string[] {
    const args = [projectPath, '--json'];
    const cfg = options.config as Record<string, unknown> | undefined;
    if (cfg?.skip) {
      for (const s of cfg.skip as string[]) args.push('--skip', s);
    }
    if (cfg?.ignore) {
      for (const ig of cfg.ignore as string[]) args.push('--ignore', ig);
    }
    return args;
  }

  private buildAvailable(start: number, issues: Issue[]): ToolResult {
    return {
      tool: 'depcheck',
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
    const err = error as { code?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return {
        tool: 'depcheck',
        status: 'unavailable',
        issues: [],
        metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
        error: this.tr('engine.inspect.tool.depcheck.unavailable'),
      };
    }
    return {
      tool: 'depcheck',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error: err.stderr || err.message || this.tr('engine.inspect.tool.depcheck.runFailed'),
    };
  }

  private mapOutput(result: DepcheckResult, projectPath: string, locale?: LanguageCode): Issue[] {
    const issues: Issue[] = [];
    const lng = locale ?? DEFAULT_LANGUAGE;
    const relPkgJson = path.relative(projectPath, path.join(projectPath, 'package.json')) || 'package.json';

    for (const dep of result.dependencies || []) {
      issues.push({
        id: randomUUID(),
        ruleId: 'depcheck/unused-dependency',
        severity: 'warning',
        category: 'dependency',
        message: translate('engine.inspect.tool.depcheck.unusedDependency', lng, { dep }),
        file: relPkgJson,
        line: 0,
        column: 0,
        suggestion: translate('engine.inspect.tool.depcheck.uninstallDependency', lng, { dep }),
        autoFixable: false,
        source: 'inspect',
        fingerprint: `depcheck:unused:${dep}`,
      });
    }

    for (const dep of result.devDependencies || []) {
      issues.push({
        id: randomUUID(),
        ruleId: 'depcheck/unused-dev-dependency',
        severity: 'info',
        category: 'dependency',
        message: translate('engine.inspect.tool.depcheck.unusedDevDependency', lng, { dep }),
        file: relPkgJson,
        line: 0,
        column: 0,
        suggestion: translate('engine.inspect.tool.depcheck.moveDevDependency', lng, { dep }),
        autoFixable: false,
        source: 'inspect',
        fingerprint: `depcheck:unused-dev:${dep}`,
      });
    }

    return issues;
  }
}
