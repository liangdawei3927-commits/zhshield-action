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
import {
  asToolExecError,
  buildAccessScope,
  buildToolResult,
  execTool,
  ToolCommandResolver,
  DEFAULT_TOOL_SCAN_TIMEOUT_MS,
} from './tool-runner';

/** jscpd `--version` 输出解析（模块级复用，避免每次探测重建） */
const JSCPD_VERSION_RE = /(\d+)\.(\d+)/;

/**
 * 不计入重复检测的路径（jscpd --ignore 与 AccessScope.excludePaths 共用同一份清单）。
 *
 * - dist/build 编译输出与 src 成对重复，占整仓重复报告大头（自扫误报）
 * - .semgrep/inline-*.yml 为 SemgrepRuleWriter 生成的临时内联规则，内容同源互相重复
 * - package.json 头部样板 / 测试与夹具结构（__tests__、*.test.*、e2e、fixtures）按脚手架约定重复为常态
 * - Markdown 不是代码：jscpd 5.x 的 markdown 解析器会把同一段落的两个半边报成互相克隆
 *   （firstFile/secondFile 指向同一文件同一行区间），产生无法处理的噪声条目
 * - HTML / SVG 同样不是代码：jscpd 的 markup 解析器按结构相似度比对，独立的 HTML 交付报告
 *   （每份自带完整 CSS 样板，刻意保持自包含可单独分发）与品牌 SVG 变体（同图不同线宽/尺寸）
 *   必然"重复"，但这是设计意图而非可提取 Helper 的代码重复——误报为重复代码会让巡检报告失真
 * - sop-templates / test-fixtures / assets / db/migrations 是模板与迁移脚本样板
 */
const JSCPD_IGNORED_PATHS: readonly string[] = [
  '**/dist/**',
  '**/build/**',
  '**/.semgrep/**',
  '**/package.json',
  '**/tsconfig*.json',
  '**/__tests__/**',
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/e2e/**',
  '**/fixtures/**',
  '**/vitest.config.*',
  '**/sop-templates/**',
  '**/test-fixtures/**',
  '**/assets/**',
  '**/db/migrations/**',
  '**/*.md',
  '**/*.html',
  '**/*.svg',
];

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

/** jscpd JSON 报告中的单条重复项 — 同时覆盖 v5.x (firstFile/secondFile) 与旧版 (first/second) */
interface JscpdDuplicate {
  format?: string;
  /** jscpd ≥5.x: name 为相对路径, start/end 为行号, startLoc/endLoc 含 line */
  firstFile?: { name?: string; start?: number; end?: number; startLoc?: { line?: number }; endLoc?: { line?: number } };
  secondFile?: { name?: string; start?: number; end?: number; startLoc?: { line?: number }; endLoc?: { line?: number } };
  /** jscpd <5 (legacy) */
  first?: {
    location?: { path?: string; start?: { line?: number } };
    path?: string;
    position?: { start?: { line?: number } };
  };
  second?: {
    location?: { path?: string; start?: { line?: number }; end?: { line?: number } };
    path?: string;
    position?: { start?: { line?: number }; end?: { line?: number }; path?: string };
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
  private readonly commands: ToolCommandResolver;

  /** F5：jscpd 默认对 src/ 做复制粘贴检测（targetFiles[0] 可覆盖目标）；
   *  monorepo（无顶层 src）时经 resolveTargetDir 落到 packages/，故同时声明 packages 读取范围 */
  readonly accessScope: AccessScope = buildAccessScope(
    ['src/**/*.{ts,tsx,js,jsx}', 'packages/**/*.{ts,tsx,js,jsx}'],
    ['**/node_modules/**', ...JSCPD_IGNORED_PATHS],
  );

  constructor(projectRoot?: string) {
    this.commands = new ToolCommandResolver('jscpd', projectRoot);
  }

  /** 缓存的 jscpd 版本号（major, minor），首次探测后复用 */
  private versionInfo?: { major: number; minor: number };

  async isAvailable(): Promise<boolean> {
    return this.commands.isAvailable();
  }

  /**
   * 探测 jscpd 版本。jscpd 5.x 起 CLI 语义发生破坏性变更（见 executeJscpd 注释），
   * 需按 major 版本选择参数集。解析失败时保守回退旧版（major=0）。
   */
  private async detectVersion(projectPath?: string): Promise<{ major: number; minor: number }> {
    if (this.versionInfo) return this.versionInfo;
    try {
      // 锚定 projectPath，不受 cwd 影响（09-12 复验修复）：版本探测与执行使用同一锚点命令
      const command = await this.commands.resolve(projectPath);
      const { stdout } = await execTool(command, ['--version'], { timeout: 20000 });
      const m = JSCPD_VERSION_RE.exec(stdout.trim());
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
    const command = await this.commands.resolve(projectPath);
    await FileHelper.ensureDir(path.dirname(reportPath));
    const { major } = await this.detectVersion(projectPath);
    // jscpd ≥5.x 破坏性变更: --format 由"输出格式"变为"输入文件格式",
    // --output 由"文件路径"变为"输出目录"; JSON 报告改用 --reporters json 生成,
    // 输出到 <output>/jscpd-report.json。旧版(<5)维持原参数集。
    // --ignore 与 accessScope.excludePaths 同步排除生成物/脚手架样板（JSCPD_IGNORED_PATHS）
    // SOP 规则顶层 thresholds（minLines/minTokens）经 ContentInterpreter 并入 options.config.thresholds：
    // jscpd CLI 有 --min-lines/--min-tokens（两者 ≥2.x 均支持），minSimilarity 无 CLI 标志（由 --mode strict 表达）。
    // 未声明时保持旧行为（jscpd 默认阈值），避免无规则直扫模式下行为回归。
    const thresholds = options.config?.thresholds ?? {};
    const thresholdArgs: string[] = [];
    if (typeof thresholds.minLines === 'number' && Number.isFinite(thresholds.minLines)) {
      thresholdArgs.push('--min-lines', String(thresholds.minLines));
    }
    if (typeof thresholds.minTokens === 'number' && Number.isFinite(thresholds.minTokens)) {
      thresholdArgs.push('--min-tokens', String(thresholds.minTokens));
    }
    const args =
      major >= 5
        ? ['--reporters', 'json', '--output', path.dirname(reportPath), '--mode', 'strict', '--ignore', JSCPD_IGNORED_PATHS.join(','), ...thresholdArgs, target]
        : ['--output', reportPath, '--format', 'json', '--mode', 'strict', '--ignore', JSCPD_IGNORED_PATHS.join(','), ...thresholdArgs, target];
    await execTool(command, args, {
      cwd: projectPath,
      timeout: options.timeout || DEFAULT_TOOL_SCAN_TIMEOUT_MS,
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
    return buildToolResult({
      tool: 'jscpd',
      status: 'available',
      issues,
      start,
      fileCount: content?.statistics?.detection?.total?.count || 0,
    });
  }

  /** 处理 jscpd 执行错误：清理报告 / 未安装 / 失败 */
  private async handleJscpdError(
    error: unknown,
    start: number,
    reportPath: string,
  ): Promise<ToolResult> {
    await this.cleanupReport(reportPath);

    const err = asToolExecError(error);
    if (err.code === 'ENOENT') {
      return buildToolResult({
        tool: 'jscpd',
        status: 'unavailable',
        issues: [],
        start,
        error: 'jscpd 未安装',
      });
    }
    return buildToolResult({
      tool: 'jscpd',
      status: 'error',
      issues: [],
      start,
      error: err.stderr || err.message || 'jscpd 执行失败',
    });
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
    const issues: Issue[] = [];
    for (const [idx, d] of out.duplicates.entries()) {
      const issue = this.mapDuplicate(d, idx);
      if (issue !== null) issues.push(issue);
    }
    return issues;
  }

  private mapDuplicate(d: JscpdDuplicate, idx: number): Issue | null {
    const firstFile = duplicatePath(d.firstFile?.name, d.first);
    const firstLines = duplicateStartLine(
      d.firstFile?.startLoc?.line,
      d.first?.location?.start?.line,
      d.first?.position?.start?.line,
    );
    const secondFile = duplicatePath(d.secondFile?.name, d.second, d.second?.position?.path);
    const secondStart = duplicateStartLine(
      d.secondFile?.startLoc?.line,
      d.second?.location?.start?.line,
      d.second?.position?.start?.line,
    );
    const secondEnd =
      d.secondFile?.endLoc?.line ||
      d.secondFile?.startLoc?.line ||
      d.second?.location?.end?.line ||
      d.second?.position?.end?.line ||
      secondStart;
    // 克隆须位于两个不同位置：上游对非代码格式偶发上报「同一文件同一行」自比条目，
    // 该类记录定位不到可提取的第二个代码块，只会污染报告
    if (firstFile === secondFile && firstLines === secondStart) return null;
    const format = d.format || 'code';
    return {
      id: randomUUID(),
      ruleId: 'jscpd/duplicate',
      severity: 'warning',
      category: 'quality',
      message: `发现重复代码 (${format}): ${firstFile}:${firstLines} ↔ ${secondFile || '?'}:${secondStart}`,
      file: firstFile,
      line: firstLines,
      column: 0,
      suggestion: `提取公共代码到共享模块 (重复位置: ${secondFile}:${secondStart}-${secondEnd})`,
      autoFixable: false,
      source: 'inspect',
      fingerprint: `jscpd:${idx}:${firstFile}:${firstLines}`,
    };
  }
}

function duplicatePath(
  modernName: string | undefined,
  legacy: JscpdDuplicate['first'],
  legacyPositionPath?: string,
): string {
  return modernName || legacy?.location?.path || legacy?.path || legacyPositionPath || '';
}

function duplicateStartLine(
  modernStartLine: number | undefined,
  legacyLocationLine: number | undefined,
  legacyPositionLine: number | undefined,
): number {
  return modernStartLine || legacyLocationLine || legacyPositionLine || 0;
}
