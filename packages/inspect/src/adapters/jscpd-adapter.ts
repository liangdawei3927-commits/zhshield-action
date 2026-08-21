import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue } from '@zh/shared';
import { FileHelper } from '@zh/kernel';

const execFileAsync = promisify(execFile);

const META: Omit<ToolMeta, 'description'> = {
  id: 'jscpd',
  name: 'jscpd',
  category: 'inspect',
  priority: 'P1',
  installMode: 'builtin',
  cliCommand: 'jscpd',
  homepage: 'https://github.com/kucherenko/jscpd',
  license: 'MIT',
};

/** jscpd JSON 报告中的单条重复项 */
interface JscpdDuplicate {
  format?: string;
  first?: {
    location?: { path?: string; start?: { line?: number } };
    path?: string;
    position?: { start?: { line?: number } };
  };
  second?: {
    location?: { path?: string };
    path?: string;
  };
}

/** jscpd JSON 报告结构 */
interface JscpdReport {
  duplicates?: JscpdDuplicate[];
  statistics?: {
    detection?: {
      total?: { count?: number };
    };
  };
}

export class JscpdAdapter implements ToolAdapter {
  meta: ToolMeta;
  private readonly locale: LanguageCode;

  constructor(locale?: LanguageCode) {
    this.locale = locale ?? DEFAULT_LANGUAGE;
    this.meta = { ...META, description: translate('engine.inspect.tool.jscpd.description', this.locale) };
  }

  private tr(key: string, params?: Record<string, unknown>): string {
    return translate(key, this.locale, params);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('jscpd', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const reportPath = path.join(options.projectPath, '.zhshield', '.jscpd-report.json');
    const target = options.targetFiles?.[0] || path.join(options.projectPath, 'src');

    try {
      const content = await this.runJscpd(options, reportPath, target);
      const issues = this.mapOutput(content, this.locale);
      await this.cleanupReport(reportPath);

      return {
        tool: 'jscpd',
        status: 'available',
        issues,
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: content?.statistics?.detection?.total?.count || 0,
        },
      };
    } catch (error: unknown) {
      await this.cleanupReport(reportPath);
      return this.buildScanError(start, error);
    }
  }

  private async runJscpd(options: ToolScanOptions, reportPath: string, target: string): Promise<JscpdReport> {
    await FileHelper.ensureDir(path.dirname(reportPath));

    const args = ['--output', reportPath, '--format', 'json', '--mode', 'strict', target];

    await execFileAsync('jscpd', args, {
      cwd: options.projectPath,
      timeout: options.timeout || 60000,
      maxBuffer: 10 * 1024 * 1024,
    });

    return (await FileHelper.readJSON(reportPath)) as JscpdReport;
  }

  private buildScanError(start: number, error: unknown): ToolResult {
    const err = error as { code?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return {
        tool: 'jscpd',
        status: 'unavailable',
        issues: [],
        metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
        error: this.tr('engine.inspect.tool.jscpd.unavailable'),
      };
    }
    return {
      tool: 'jscpd',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error: err.stderr || err.message || this.tr('engine.inspect.tool.jscpd.runFailed'),
    };
  }

  private async cleanupReport(reportPath: string): Promise<void> {
    try { await fs.promises.unlink(reportPath); } catch { /* ignore */ }
  }

  private mapOutput(output: unknown, locale?: LanguageCode): Issue[] {
    const out = output as JscpdReport;
    if (!out?.duplicates || !Array.isArray(out.duplicates)) return [];
    const lng = locale ?? DEFAULT_LANGUAGE;
    return out.duplicates.map((d, idx) => {
      const firstFile = d.first?.location?.path || d.first?.path || '';
      const firstLines = d.first?.location?.start?.line || d.first?.position?.start?.line || 0;
      const secondFile = d.second?.location?.path || d.second?.path || '';
      const format = d.format || 'code';
      return {
        id: randomUUID(),
        ruleId: 'jscpd/duplicate',
        severity: 'warning',
        category: 'quality',
        message: translate('engine.inspect.tool.jscpd.duplicateFound', lng, { format, firstFile, firstLines, secondFile: secondFile || '?' }),
        file: firstFile,
        line: firstLines,
        column: 0,
        suggestion: translate('engine.inspect.tool.jscpd.extractShared', lng, { secondFile }),
        autoFixable: false,
        source: 'inspect',
        fingerprint: `jscpd:${idx}:${firstFile}:${firstLines}`,
      };
    });
  }
}
