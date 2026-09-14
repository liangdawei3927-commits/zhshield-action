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
import { isCommandAvailable } from './tool-available';

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
  /** 按锚点（projectRoot ?? projectPath）缓存解析结果；isAvailable 的无锚点 PATH 探测与 scan 的项目本地解析互不污染（09-12 复验修复） */
  private readonly commandCache = new Map<string, Promise<string>>();
  private readonly projectRoot?: string;

  /** F5：jscpd 默认对 src/ 做复制粘贴检测（targetFiles[0] 可覆盖目标）；
   *  monorepo（无顶层 src）时经 resolveTargetDir 落到 packages/，故同时声明 packages 读取范围 */
  readonly accessScope: AccessScope = {
    readPaths: ['src/**/*.{ts,tsx,js,jsx}', 'packages/**/*.{ts,tsx,js,jsx}'],
    excludePaths: ['**/node_modules/**'],
  };

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot;
  }

  private resolveCommand(projectPath?: string): Promise<string> {
    // 锚定 projectPath，不受 cwd 影响（09-12 复验修复）：anchor = projectRoot ?? projectPath，
    // 无锚点时仅 PATH/共享目录探测（isAvailable 用），scan 时以 options.projectPath 锚定本地 bin。
    const anchor = this.projectRoot ?? projectPath;
    const key = anchor ?? '';
    let cached = this.commandCache.get(key);
    if (!cached) {
      cached = resolveToolCommand('jscpd', anchor);
      this.commandCache.set(key, cached);
    }
    return cached;
  }

  async isAvailable(): Promise<boolean> {
    return isCommandAvailable(() => this.resolveCommand());
  }

  /** 缓存的 jscpd 版本号（major, minor），首次探测后复用 */
  private versionInfo?: { major: number; minor: number };

  /**
   * 探测 jscpd 版本。jscpd 5.x 起 CLI 语义发生破坏性变更（见 executeJscpd 注释），
   * 需按 major 版本选择参数集。解析失败时保守回退旧版（major=0）。
   */
  private async detectVersion(projectPath?: string): Promise<{ major: number; minor: number }> {
    if (this.versionInfo) return this.versionInfo;
    try {
      // 锚定 projectPath，不受 cwd 影响（09-12 复验修复）：版本探测与执行使用同一锚点命令
      const command = await this.resolveCommand(projectPath);
      const { stdout } = await execFileAsync(command, ['--version'], { timeout: 20000 });
      const m = /(\d+)\.(\d+)/.exec(stdout.trim());
      this.versionInfo = m
        ? { major: Number(m[1]), minor: Number(m[2]) }
        : { major: 0, minor: 0 };
    } catch {
      this.versionInfo = { major: 0, minor: 0 };
    }
    return this.versionInfo;
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    // 归一化 projectPath 为绝对路径：相对路径会流入报告路径与扫描目标，
    // jscpd 以自身 cwd 解析相对路径导致扫描失败。
    const projectPath = path.resolve(options.projectPath);
    const reportPath = path.join(projectPath, '.zhshield', '.jscpd-report.json');

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
    const projectPath = path.resolve(options.projectPath);
    const target = options.targetFiles?.[0] || this.resolveTargetDir(projectPath);
    await this.executeJscpd(options, target, reportPath);
    const content = await this.readJscpdReport(reportPath, projectPath);
    const issues = this.mapOutput(content);
    return this.buildJscpdAvailable(content, issues, start);
  }

  /** 目标目录解析：src → packages → 项目根(对齐 SemgrepAdapter，避免 monorepo 无顶层 src 时报"未找到可扫描的源文件目录") */
  private resolveTargetDir(projectPath: string): string {
    const srcDir = path.join(projectPath, 'src');
    if (fs.existsSync(srcDir)) return srcDir;
    const packagesDir = path.join(projectPath, 'packages');
    if (fs.existsSync(packagesDir)) return packagesDir;
    return projectPath;
  }

  /** 运行 jscpd 命令并输出 JSON 报告到 reportPath */
  private async executeJscpd(
    options: ToolScanOptions,
    target: string,
    reportPath: string,
  ): Promise<void> {
    const projectPath = path.resolve(options.projectPath);
    const command = await this.resolveCommand(projectPath);
    await FileHelper.ensureDir(path.dirname(reportPath));
    const { major } = await this.detectVersion(projectPath);
    // jscpd ≥5.x 破坏性变更: --format 由"输出格式"变为"输入文件格式",
    // --output 由"文件路径"变为"输出目录"; JSON 报告改用 --reporters json 生成,
    // 输出到 <output>/jscpd-report.json。旧版(<5)维持原参数集。
    const args =
      major >= 5
        ? ['--reporters', 'json', '--output', path.dirname(reportPath), '--mode', 'strict', target]
        : ['--output', reportPath, '--format', 'json', '--mode', 'strict', target];
    await execFileAsync(command, args, {
      cwd: projectPath,
      timeout: options.timeout || 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  /** 读取 jscpd 报告并清理临时文件 */
  private async readJscpdReport(reportPath: string, projectPath: string): Promise<JscpdReport> {
    projectPath = path.resolve(projectPath);
    let p = reportPath;
    if ((await this.detectVersion(projectPath)).major >= 5) {
      const v5Report = path.join(path.dirname(reportPath), 'jscpd-report.json');
      try {
        await fs.promises.access(v5Report);
        p = v5Report;
      } catch {
        /* jscpd 未生成 5.x 报告，回退原路径 */
      }
    }
    const content = (await FileHelper.readJSON(p)) as JscpdReport;
    await this.cleanupReport(p);
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
