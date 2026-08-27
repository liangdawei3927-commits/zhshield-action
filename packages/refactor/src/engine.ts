import * as fs from 'fs';
import { safeJoin, safeResolve } from '@zh/shared';
import { parseFile, type ParsedFile } from './ast-helper';
import { ALL_DETECTORS, type DetectorSet } from './adapters/index';
import type {
  CodeSmell,
  FileSmellReport,
  RefactorReport,
  RefactorConfig,
} from './types';
import { DEFAULT_CONFIG } from './types';
import { generateFixes, applyFixes } from './auto-fix';
import type { Fix, FixResult } from './types';

const TS_FILE_PATTERN = /\.tsx?$/;

// 测试/夹具目录不参与产品代码质量检测：
// 夹具是其他工具（如 dependency-cruiser、semgrep、本包测试）的解析样本，
// 修改它们会破坏各自测试套件。SOP 规则源已迁移至 @zh/kernel 的
// src/sop/presets/（sop-presets/sop-templates）与 src/sop/tool-packs/。
const EXCLUDED_DIRS = new Set([
  'node_modules', 'dist', '.git', '.turbo', 'build', 'coverage',
  '__mocks__', '__tests__', 'test', 'tests', 'fixtures', '__fixtures__', 'spec',
]);

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function warn(msg: string): void {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'test') {
    console.error(`[refactor] ${msg}`);
  }
}

/** 报告聚合过程中的中间状态容器 */
interface ReportState {
  fileReports: FileSmellReport[];
  totalSmells: number;
  byCategory: Record<string, number>;
  bySeverity: { error: number; warning: number; info: number };
  suggestionsByType: Record<string, number>;
}

export class RefactorEngine {
  private config: RefactorConfig;
  private detectors: DetectorSet[];

  constructor(config?: Partial<RefactorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config, thresholds: { ...DEFAULT_CONFIG.thresholds, ...config?.thresholds } };
    this.detectors = ALL_DETECTORS.filter(d =>
      this.config.enabledRules.includes(d.name)
    );
  }

  async analyzeDirectory(
    projectRoot: string,
  ): Promise<RefactorReport> {
    const tsFiles = this.collectTsFiles(projectRoot);
    return this.analyzeFiles(projectRoot, tsFiles);
  }

  async analyzeFiles(
    projectRoot: string,
    filePaths: string[],
  ): Promise<RefactorReport> {
    const { parsedFiles, parseErrors } = await this.parseFiles(filePaths);
    if (parseErrors.length > 0) {
      warn(`无法解析 ${parseErrors.length} 个文件 (如: ${parseErrors[0]})`);
    }

    const { fileReports, totalSmells, byCategory, bySeverity, suggestionsByType } =
      await this.detectFileReports(parsedFiles);
    fileReports.sort((a, b) => b.maintainabilityScore - a.maintainabilityScore);

    return {
      timestamp: new Date().toISOString(),
      projectRoot,
      totalFiles: filePaths.length,
      scannedFiles: parsedFiles.length,
      totalSmells,
      byCategory,
      bySeverity,
      files: fileReports,
      summary: this.buildSummary(fileReports, suggestionsByType),
    };
  }

  /** 汇总报告优先级统计 */
  private buildSummary(
    fileReports: FileSmellReport[],
    suggestionsByType: Record<string, number>,
  ): RefactorReport['summary'] {
    const criticalFiles = fileReports.filter(f => f.refactorPriority === 'critical').length;
    const needsImmediateAction = fileReports.filter(f =>
      f.refactorPriority === 'critical' || f.refactorPriority === 'high'
    ).length;

    return {
      criticalFiles,
      needsImmediateAction,
      suggestionsByType,
    };
  }

  private async parseFiles(
    filePaths: string[],
  ): Promise<{ parsedFiles: ParsedFile[]; parseErrors: string[] }> {
    const parsedFiles: ParsedFile[] = [];
    const parseErrors: string[] = [];

    for (let i = 0; i < filePaths.length; i++) {
      const fp = filePaths[i];
      try {
        const parsed = parseFile(fp);
        parsedFiles.push(parsed);
      } catch {
        parseErrors.push(fp);
      }
      // 每处理 10 个文件让出事件循环，避免阻塞 IPC 等主进程任务
      if (i > 0 && i % 10 === 0) {
        await yieldToEventLoop();
      }
    }

    return { parsedFiles, parseErrors };
  }

  private async detectFileReports(parsedFiles: ParsedFile[]): Promise<ReportState> {
    const state = this.initReportState();

    for (let i = 0; i < parsedFiles.length; i++) {
      this.processFileReport(parsedFiles[i], parsedFiles, state);
      // 每检测 5 个文件让出事件循环（每个文件跑 20 个检测器，比解析更耗时）
      if (i > 0 && i % 5 === 0) {
        await yieldToEventLoop();
      }
    }

    return state;
  }

  /** 初始化报告聚合状态容器 */
  private initReportState(): ReportState {
    return {
      fileReports: [],
      totalSmells: 0,
      byCategory: { structural: 0, coupling: 0, inheritance: 0 },
      bySeverity: { error: 0, warning: 0, info: 0 },
      suggestionsByType: {},
    };
  }

  /** 检测单个文件的代码异味并聚合到报告状态 */
  private processFileReport(
    parsed: ParsedFile,
    parsedFiles: ParsedFile[],
    state: ReportState,
  ): void {
    const fileSmells = this.detectAllSmells(parsed, parsedFiles);
    if (fileSmells.length === 0) return;

    const maintainabilityScore = this.calculateMaintainability(fileSmells);
    const priority = this.calculatePriority(fileSmells);
    state.fileReports.push({
      filePath: parsed.filePath,
      totalSmells: fileSmells.length,
      smells: fileSmells,
      maintainabilityScore,
      refactorPriority: priority,
    });

    state.totalSmells += fileSmells.length;
    for (const s of fileSmells) {
      state.byCategory[s.category] = (state.byCategory[s.category] || 0) + 1;
      state.bySeverity[s.severity as keyof typeof state.bySeverity]++;
      const type = s.suggestion.type;
      state.suggestionsByType[type] = (state.suggestionsByType[type] || 0) + 1;
    }
  }

  async analyzeStagedFiles(
    projectRoot: string,
  ): Promise<RefactorReport> {
    const { execSync } = await import('child_process');
    try {
      const output = execSync('git diff --cached --name-only --diff-filter=ACM', {
        cwd: projectRoot,
        encoding: 'utf-8',
      });
      const stagedFiles = output
        .split('\n')
        .filter(f => f.trim() && (f.endsWith('.ts') || f.endsWith('.tsx')))
        .map(f => safeResolve(projectRoot, f));
      return this.analyzeFiles(projectRoot, stagedFiles);
    } catch (e) {
      warn(`Git diff 失败: ${e}`);
      return this.analyzeFiles(projectRoot, []);
    }
  }

  private detectAllSmells(parsed: ParsedFile, allFiles: ParsedFile[]): CodeSmell[] {
    const allSmells: CodeSmell[] = [];
    for (const detector of this.detectors) {
      try {
        const found = detector.detect(parsed, allFiles, this.config);
        allSmells.push(...found);
      } catch (e) {
        warn(`检测器 ${detector.name} 执行失败: ${e}`);
      }
    }
    return allSmells;
  }

  private calculateMaintainability(smells: CodeSmell[]): number {
    if (smells.length === 0) return 100;
    const weights = { error: 15, warning: 8, info: 3 };
    const totalWeight = smells.reduce((sum, s) => {
      const w = weights[s.severity as keyof typeof weights] || 3;
      return sum + w;
    }, 0);
    const score = 100 - totalWeight;
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  private calculatePriority(
    smells: CodeSmell[],
  ): 'critical' | 'high' | 'medium' | 'low' {
    const errorCount = smells.filter(s => s.severity === 'error').length;
    const warningCount = smells.filter(s => s.severity === 'warning').length;
    if (errorCount >= 3) return 'critical';
    if (errorCount >= 1 || warningCount >= 5) return 'high';
    if (warningCount >= 2) return 'medium';
    return 'low';
  }

  /** 为指定代码异味生成自动修复建议 */
  async generateFixes(projectRoot: string, smells?: CodeSmell[]): Promise<Fix[]> {
    if (smells) {
      return generateFixes(smells, projectRoot);
    }
    // 若无指定，先扫描再生成
    const report = await this.analyzeDirectory(projectRoot);
    const allSmells = report.files.flatMap(f => f.smells);
    return generateFixes(allSmells, projectRoot);
  }

  /** 应用修复编辑 */
  applyFixes(fixes: Fix[]): FixResult {
    return applyFixes(fixes);
  }

  private collectTsFiles(dir: string): string[] {
    const files: string[] = [];
    this.walkTsFiles(dir, files);
    return files;
  }

  /** 递归遍历目录收集 TypeScript 源文件 */
  private walkTsFiles(current: string, files: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (e) {
      warn(`无法访问目录 ${current}: ${e}`);
      return;
    }

    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const fullPath = safeJoin(current, entry.name);
      if (entry.isDirectory()) {
        if (this.isExcludedDir(entry.name)) continue;
        this.walkTsFiles(fullPath, files);
        continue;
      }
      if (entry.isFile() && this.isTsSourceFile(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  /** 判断目录是否被排除（黑名单目录或以点开头的隐藏目录） */
  private isExcludedDir(name: string): boolean {
    return EXCLUDED_DIRS.has(name) || name.startsWith('.');
  }

  /** 判断是否为可检测的 TypeScript 源文件（排除 .d.ts 声明文件） */
  private isTsSourceFile(name: string): boolean {
    return TS_FILE_PATTERN.test(name) && !name.endsWith('.d.ts');
  }
}
