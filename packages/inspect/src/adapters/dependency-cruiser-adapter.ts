import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue } from '@zh/shared';

const execFileAsync = promisify(execFile);

const META: Omit<ToolMeta, 'description'> = {
  id: 'dep-cruiser',
  name: 'Dependency Cruiser',
  category: 'inspect',
  priority: 'P1',
  installMode: 'builtin',
  cliCommand: 'depcruise',
  homepage: 'https://github.com/sverweij/dependency-cruiser',
  license: 'MIT',
};

/** Dependency-cruiser JSON 输出中的单条违规 */
interface DepCruiserViolation {
  rule?: { name?: string; severity?: string };
  from?: { path?: string; line?: number };
  to?: { path?: string };
}

/** Dependency-cruiser JSON 输出结构 */
interface DepCruiserOutput {
  summary?: { violations?: DepCruiserViolation[] };
}

export class DependencyCruiserAdapter implements ToolAdapter {
  meta: ToolMeta;
  private readonly locale: LanguageCode;

  constructor(locale?: LanguageCode) {
    this.locale = locale ?? DEFAULT_LANGUAGE;
    this.meta = { ...META, description: translate('engine.inspect.tool.dep-cruiser.description', this.locale) };
  }

  private tr(key: string, params?: Record<string, unknown>): string {
    return translate(key, this.locale, params);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('depcruise', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const configFile = this.resolveConfig(options.projectPath);
    const targetDir = path.join(options.projectPath, 'src');

    try {
      const stdout = await this.runDepCruise(options, configFile, targetDir);
      const output = JSON.parse(stdout);
      return this.buildAvailable(start, output);
    } catch (error: unknown) {
      return this.buildScanError(start, error);
    }
  }

  private async runDepCruise(options: ToolScanOptions, configFile: string | null, targetDir: string): Promise<string> {
    const args: string[] = [];
    if (configFile) {
      args.push('--validate', configFile);
    }
    args.push('--output-type', 'json', targetDir);

    const { stdout } = await execFileAsync('depcruise', args, {
      cwd: options.projectPath,
      timeout: options.timeout || 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  private buildAvailable(start: number, output: unknown): ToolResult {
    const issues = this.mapOutput(output, this.locale);
    const modules = (output as { modules?: unknown[] }).modules;
    return {
      tool: 'dep-cruiser',
      status: 'available',
      issues,
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: modules?.length || 0,
      },
    };
  }

  private buildScanError(start: number, error: unknown): ToolResult {
    const err = error as { code?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return {
        tool: 'dep-cruiser',
        status: 'unavailable',
        issues: [],
        metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
        error: this.tr('engine.inspect.tool.dep-cruiser.unavailable'),
      };
    }
    return {
      tool: 'dep-cruiser',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error: err.stderr || err.message || this.tr('engine.inspect.tool.dep-cruiser.runFailed'),
    };
  }

  private resolveConfig(projectPath: string): string | null {
    const candidates = [
      '.dependency-cruiser.js',
      '.dependency-cruiser.cjs',
      '.dependency-cruiser.json',
    ];
    for (const name of candidates) {
      const p = path.join(projectPath, name);
      if (fs.existsSync(p)) return p;
      const zhshield = path.join(projectPath, '.zhshield', name);
      if (fs.existsSync(zhshield)) return zhshield;
    }
    return null;
  }

  private mapOutput(output: unknown, locale?: LanguageCode): Issue[] {
    const out = output as DepCruiserOutput;
    if (!out?.summary?.violations || !Array.isArray(out.summary.violations)) return [];
    return out.summary.violations.map((v) => this.mapViolationToIssue(v, locale));
  }

  private mapViolationToIssue(v: DepCruiserViolation, locale?: LanguageCode): Issue {
    return {
      id: randomUUID(),
      ruleId: v.rule?.name || 'dep-cruiser/violation',
      severity: this.mapSeverity(v.rule?.severity),
      category: 'architecture',
      message: this.buildViolationMessage(v, locale),
      file: v.from?.path || '',
      line: v.from?.line || 0,
      column: 0,
      suggestion: this.buildViolationSuggestion(v, locale),
      autoFixable: false,
      source: 'inspect',
      fingerprint: this.buildViolationFingerprint(v),
    };
  }

  private mapSeverity(severity: string | undefined): Issue['severity'] {
    return severity === 'error' ? 'error' : severity === 'warn' ? 'warning' : 'info';
  }

  private buildViolationMessage(v: DepCruiserViolation, locale?: LanguageCode): string {
    const lng = locale ?? DEFAULT_LANGUAGE;
    const rule = v.rule?.name || translate('engine.inspect.unknownRule', lng);
    return translate('engine.inspect.tool.dep-cruiser.architectureViolation', lng, {
      rule,
      from: v.from?.path || '?',
      to: v.to?.path || '?',
    });
  }

  private buildViolationSuggestion(v: DepCruiserViolation, locale?: LanguageCode): string {
    return translate('engine.inspect.tool.dep-cruiser.noCrossReference', locale ?? DEFAULT_LANGUAGE, {
      from: v.from?.path || '',
      to: v.to?.path || '',
    });
  }

  private buildViolationFingerprint(v: DepCruiserViolation): string {
    return `dep-cruiser:${v.rule?.name || ''}:${v.from?.path || ''}:${v.to?.path || ''}`;
  }
}
