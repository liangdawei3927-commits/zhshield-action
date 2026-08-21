import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageCode } from '@zh/i18n';
import type { ProjectProfile } from '@zh/dependency';
import type { InspectionReport, AdapterResult, Issue, IssueSeverity, InspectAdapter } from './types';
import type { ToolAdapter, EventEmitter } from '@zh/shared';
import type { SopRuleEngine } from '@zh/kernel';
import { DegradationManager, AuditLogger, ToolManager, NOOP_EMITTER } from '@zh/shared';
import { AdapterRunner } from './adapter-runner';
import { ToolAdapterExecutor } from './tool-adapter-executor';
import { ScanReportBuilder } from './scan-report-builder';
import { SopReportMapper } from './sop-report-mapper';
import { AiCodeReviewImpl } from './ai-code/review';
import type { AiCodeVuln, AiVulnSeverity } from './ai-code/types';

interface ScanContext {
  projectId: string;
  scanType: InspectionReport['scanType'];
  startedAt: number;
  locale?: LanguageCode;
}

/** 从文件系统读取最小 ProjectProfile，供 AI 审查使用（纯函数，无网络/执行） */
export function buildProjectProfile(projectPath: string): ProjectProfile {
  const language = detectLanguage(projectPath);
  const framework = detectFramework(projectPath);
  const packageManager = detectPackageManager(projectPath);
  const hasTypeScript = detectTypeScript(projectPath);
  return { projectPath, language, framework, packageManager, hasTypeScript };
}

function detectLanguage(projectPath: string): ProjectProfile['language'] {
  try {
    const raw = readFileSync(join(projectPath, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps = pkg.dependencies as Record<string, unknown> | undefined;
    const devDeps = pkg.devDependencies as Record<string, unknown> | undefined;
    const allKeys = [
      ...Object.keys(deps ?? {}),
      ...Object.keys(devDeps ?? {}),
    ];
    if (allKeys.some((k) => k === 'typescript' || k === 'ts-node' || k.startsWith('ts-'))) {
      return 'typescript';
    }
    return 'javascript';
  } catch {
    return 'unknown';
  }
}

function detectFramework(projectPath: string): string | null {
  try {
    const raw = readFileSync(join(projectPath, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps = pkg.dependencies as Record<string, unknown> | undefined;
    const devDeps = pkg.devDependencies as Record<string, unknown> | undefined;
    const allKeys = [
      ...Object.keys(deps ?? {}),
      ...Object.keys(devDeps ?? {}),
    ];
    if (allKeys.some((k) => k === 'next')) return 'next';
    if (allKeys.some((k) => k === '@nestjs/core')) return 'nestjs';
    if (allKeys.some((k) => k === 'react')) return 'react';
    if (allKeys.some((k) => k === 'vue')) return 'vue';
    if (allKeys.some((k) => k === 'express')) return 'express';
    if (allKeys.some((k) => k === 'fastify')) return 'fastify';
    return null;
  } catch {
    return null;
  }
}

function detectPackageManager(projectPath: string): ProjectProfile['packageManager'] {
  try {
    const raw = readFileSync(join(projectPath, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const pm = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
    if (pm.startsWith('pnpm')) return 'pnpm';
    if (pm.startsWith('yarn')) return 'yarn';
    if (pm.startsWith('npm')) return 'npm';
  } catch { /* fallthrough */ }
  return 'unknown';
}

function detectTypeScript(projectPath: string): boolean {
  try {
    readFileSync(join(projectPath, 'tsconfig.json'), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

const VULN_SEVERITY_MAP: Record<AiVulnSeverity, IssueSeverity> = {
  critical: 'error',
  high: 'warning',
  medium: 'warning',
  low: 'info',
};

/** 将 AI 深度审查漏洞映射为巡检 Issue（category=security, source=ai-code-review） */
export function aiVulnsToIssues(vulns: readonly AiCodeVuln[]): Issue[] {
  return vulns.map((v) => ({
    id: v.vulnId,
    ruleId: v.ruleId,
    severity: VULN_SEVERITY_MAP[v.severity],
    category: 'security' as const,
    message: v.description,
    file: v.file,
    line: v.line,
    autoFixable: true,
    source: 'ai-code-review',
    fingerprint: v.vulnId,
  }));
}

/**
 * InspectEngine — 巡检引擎（门面）
 *
 * 职责：注册/管理适配器，编排巡检流程（直接执行或 SOP 驱动），
 * 聚合执行与报告构建。具体职责已拆分：
 * - ToolAdapterExecutor：适配器执行循环
 * - ScanReportBuilder：汇总/评分/建议/事件
 * - SopReportMapper：SOP 报告结构映射
 */
export class InspectEngine {
  private runner: AdapterRunner;
  private toolManager: ToolManager;
  private degradationManager: DegradationManager;
  private auditLogger: AuditLogger;
  private registeredAdapters = new Map<string, ToolAdapter>();
  private emitter: EventEmitter;
  private sopEngine?: SopRuleEngine;
  /** SOP 重入保护：防止 scanner-dispatch 规则回调 runScan → 再次 evaluateRules 造成无限递归 */
  private _sopScanning = false;
  private adapterExecutor: ToolAdapterExecutor;
  private reportBuilder: ScanReportBuilder;
  private sopMapper: SopReportMapper;

  constructor(emitter?: EventEmitter) {
    this.runner = new AdapterRunner();
    this.toolManager = new ToolManager();
    this.degradationManager = new DegradationManager();
    this.auditLogger = new AuditLogger();
    this.emitter = emitter ?? NOOP_EMITTER;
    this.adapterExecutor = new ToolAdapterExecutor({
      degradationManager: this.degradationManager,
      auditLogger: this.auditLogger,
      emitter: this.emitter,
    });
    this.reportBuilder = new ScanReportBuilder(this.emitter, this.degradationManager);
    this.sopMapper = new SopReportMapper();
  }

  /** 切换至 SOP 驱动模式 — 从 SopRuleEngine 获取 inspect/security 域规则并执行 */
  useSopEngine(engine: SopRuleEngine): void {
    this.sopEngine = engine;
    // 将已注册的 ToolAdapter 全部注入 SOP 引擎，供 tool-dispatch 使用
    for (const [, adapter] of this.registeredAdapters) {
      engine.registerToolAdapter(adapter.meta.id, adapter);
    }
  }

  registerAdapter(adapter: ToolAdapter | InspectAdapter): void {
    if ('meta' in adapter && 'scan' in adapter) {
      const toolAdapter = adapter as ToolAdapter;
      this.registeredAdapters.set(toolAdapter.meta.id, toolAdapter);
      this.toolManager.register(toolAdapter);
      if (this.sopEngine) {
        this.sopEngine.registerToolAdapter(toolAdapter.meta.id, toolAdapter);
      }
    } else {
      this.runner.register(adapter);
    }
  }

  getToolManager(): ToolManager {
    return this.toolManager;
  }

  getDegradationManager(): DegradationManager {
    return this.degradationManager;
  }

  async runScan(
    projectId: string,
    scanType: InspectionReport['scanType'] = 'full',
    locale?: LanguageCode,
  ): Promise<InspectionReport> {
    const ctx: ScanContext = { projectId, scanType, startedAt: Date.now(), locale };

    if (this.shouldRunWithSop()) {
      return await this.runScanWithSopGuard(ctx);
    }

    return this.runScanWithDirect(ctx);
  }

  private shouldRunWithSop(): boolean {
    // SOP 驱动模式：通过 SopRuleEngine 评估 inspect/security 域规则
    // ⚠️ 重入保护：_sopScanning 标志防止 SOP scanner-dispatch 规则回调 runScan 导致无限递归
    // SOP → evaluateRules → scanner-dispatch → runScan → SOP → evaluateRules → ...
    return !!(this.sopEngine && !this._sopScanning);
  }

  private async runScanWithSopGuard(ctx: ScanContext): Promise<InspectionReport> {
    this._sopScanning = true;
    try {
      return await this.runScanWithSop(ctx);
    } finally {
      this._sopScanning = false;
    }
  }

  private async runScanWithDirect(ctx: ScanContext): Promise<InspectionReport> {
    const { projectId, scanType, startedAt } = ctx;
    const adapterResults: AdapterResult[] = await this.adapterExecutor.runAll(this.registeredAdapters, projectId);
    const legacyResults = await this.runner.runAll({ projectId, scanType });
    adapterResults.push(...legacyResults);

    const allIssues: Issue[] = adapterResults.flatMap((r) => r.issues);
    await this.appendAiCodeReview(projectId, allIssues);
    await this.reportBuilder.emitScanCompleted(projectId, Date.now() - startedAt, allIssues);

    return this.reportBuilder.buildReport({
      projectId,
      scanType,
      duration: Date.now() - startedAt,
      issues: allIssues,
      adapterResults,
    }, ctx.locale);
  }

  private async runScanWithSop(ctx: ScanContext): Promise<InspectionReport> {
    const { projectId, scanType, startedAt } = ctx;
    const inspectReport = await this.sopEngine!.evaluateRules({
      repoRoot: projectId,
      domain: 'inspect',
    });
    const securityReport = await this.sopEngine!.evaluateRules({
      repoRoot: projectId,
      domain: 'security',
    });
    const sopReport = this.sopMapper.mergeReports(inspectReport, securityReport);

    const issues = this.sopMapper.flattenViolations(sopReport);
    const adapterResults = this.sopMapper.buildAdapterResults(sopReport);

    await this.appendAiCodeReview(projectId, issues);
    await this.reportBuilder.emitScanCompleted(projectId, Date.now() - startedAt, issues);

    return this.reportBuilder.buildReport({
      projectId,
      scanType,
      duration: Date.now() - startedAt,
      issues,
      adapterResults,
      penalizeInfo: false,
    }, ctx.locale);
  }

  private async appendAiCodeReview(projectId: string, issues: Issue[]): Promise<void> {
    try {
      const review = new AiCodeReviewImpl();
      const profile = buildProjectProfile(projectId);
      const vulns = await review.deepReview(profile);
      issues.push(...aiVulnsToIssues(vulns));
    } catch {
      console.warn('[inspect] AI code review skipped — error during deepReview');
    }
  }
}
