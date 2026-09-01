import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ToolAdapter,
  ToolMeta,
  ToolResult,
  ToolScanOptions,
  Issue,
  AccessScope,
} from '@zh/shared';
import { FileHelper } from '@zh/kernel';
import { resolveToolCommand } from './tool-bin';

const execFileAsync = promisify(execFile);

const META: ToolMeta = {
  id: 'jscpd',
  name: 'jscpd',
  category: 'inspect',
  priority: 'P1',
  installMode: 'builtin',
  description: '重复代码检测',
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
  meta = META;
  private commandPromise?: Promise<string>;
  private readonly projectRoot?: string;

  /** F5：jscpd 默认对 src/ 做复制粘贴检测（targetFiles[0] 可覆盖目标） */
  readonly accessScope: AccessScope = {
    readPaths: ['src/**/*.{ts,tsx,js,jsx}'],
    excludePaths: ['**/node_modules/**'],
  };

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot;
  }

  private resolveCommand(): Promise<string> {
    if (!this.commandPromise) {
      this.commandPromise = resolveToolCommand('jscpd', this.projectRoot);
    }
    return this.commandPromise;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const command = await this.resolveCommand();
      const { stdout } = await execFileAsync(command, ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const reportPath = path.join(options.projectPath, '.zhshield', '.jscpd-report.json');

    try {
      return await this.runJscpd(options, start, reportPath);
    } catch (error: unknown) {
      return this.handleJscpdError(error, start, reportPath);
    }
  }

  /** 执行 jscpd、读取报告并映射为可用结果 */
  private async runJscpd(
    options: ToolScanOptions,
    start: number,
    reportPath: string,
  ): Promise<ToolResult> {
    const target = options.targetFiles?.[0] || path.join(options.projectPath, 'src');
    await this.executeJscpd(options, target, reportPath);
    const content = await this.readJscpdReport(reportPath);
    const issues = this.mapOutput(content);
    return this.buildJscpdAvailable(content, issues, start);
  }

  /** 运行 jscpd 命令并输出 JSON 报告到 reportPath */
  private async executeJscpd(
    options: ToolScanOptions,
    target: string,
    reportPath: string,
  ): Promise<void> {
    const command = await this.resolveCommand();
    await FileHelper.ensureDir(path.dirname(reportPath));
    const args = ['--output', reportPath, '--format', 'json', '--mode', 'strict', target];
    await execFileAsync(command, args, {
      cwd: options.projectPath,
      timeout: options.timeout || 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  /** 读取 jscpd 报告并清理临时文件 */
  private async readJscpdReport(reportPath: string): Promise<JscpdReport> {
    const content = (await FileHelper.readJSON(reportPath)) as JscpdReport;
    await this.cleanupReport(reportPath);
    return content;
  }

  /** 组装 jscpd 可用结果 */
  private buildJscpdAvailable(content: JscpdReport, issues: Issue[], start: number): ToolResult {
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
  }

  /** 处理 jscpd 执行错误：清理报告 / 未安装 / 失败 */
  private async handleJscpdError(
    error: unknown,
    start: number,
    reportPath: string,
  ): Promise<ToolResult> {
    await this.cleanupReport(reportPath);

    const err = error as { code?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return {
        tool: 'jscpd',
        status: 'unavailable',
        issues: [],
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: 0,
        },
        error: 'jscpd 未安装',
      };
    }
    return {
      tool: 'jscpd',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error: err.stderr || err.message || 'jscpd 执行失败',
    };
  }

  private async cleanupReport(reportPath: string): Promise<void> {
    try {
      await fs.promises.unlink(reportPath);
    } catch {
      /* ignore */
    }
  }

  private mapOutput(output: unknown): Issue[] {
    const out = output as JscpdReport;
    if (!out?.duplicates || !Array.isArray(out.duplicates)) return [];
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
        message: `发现重复代码 (${format}): ${firstFile}:${firstLines} ↔ ${secondFile || '?'}`,
        file: firstFile,
        line: firstLines,
        column: 0,
        suggestion: `提取公共代码到共享模块 (重复位置: ${secondFile})`,
        autoFixable: false,
        source: 'inspect',
        fingerprint: `jscpd:${idx}:${firstFile}:${firstLines}`,
      };
    });
  }
}
