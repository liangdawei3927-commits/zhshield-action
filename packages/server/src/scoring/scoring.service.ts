import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ScoringEngine,
  buildHealthDimensions,
  convertGuardEvaluations,
  convertInspectEvaluations,
  type ConvertedGuardResult,
  type ConvertedInspectIssue,
  type HealthScore,
} from '@zh/scoring';
import { DbConnection } from '@zh/db';
import type { PipelineReport } from '@zh/pipeline';
import type { GuardReport } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * 服务端评分服务。
 *
 * 默认内存模式（便于单测）；调用 {@link initialize} 后切换为 SQLite 持久化
 * （DbConnection + 迁移），管线跑完后经 {@link recordPipelineScore} 落库，
 * `GET /scoring/score/:projectId` 即可读到分数。
 */
@Injectable()
export class ScoringService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScoringService.name);
  private engine: ScoringEngine;
  private dbConn: DbConnection | null = null;
  private initialized = false;

  constructor() {
    this.engine = new ScoringEngine();
  }

  onModuleInit(): void {
    this.initialize();
  }

  /**
   * 初始化持久化（幂等）。失败时降级为内存模式，不阻断服务启动。
   *
   * @param dbPath SQLite 路径；缺省取 `ZH_SERVER_DB` 环境变量或 `~/.zhshield/server/zh-codeshield.db`
   */
  initialize(dbPath?: string): void {
    if (this.initialized) return;

    const resolved =
      dbPath ??
      process.env.ZH_SERVER_DB ??
      path.join(os.homedir(), '.zhshield', 'server', 'zh-codeshield.db');
    try {
      const conn = new DbConnection({ dbPath: resolved, walMode: true });
      const db = conn.connect();
      const migrationsDir = this.resolveMigrationsDir();
      if (migrationsDir) conn.migrate(migrationsDir);
      this.dbConn = conn;
      this.engine = new ScoringEngine(db);
      this.initialized = true;
      this.logger.log(`Scoring persistence initialized: ${resolved}`);
    } catch (err) {
      this.logger.warn(
        `评分持久化不可用，降级内存模式: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 定位 db 迁移目录（优先 monorepo packages/db/migrations，兼容编译产物相对路径） */
  private resolveMigrationsDir(): string | null {
    const candidates = [
      path.resolve(__dirname, '..', '..', '..', 'db', 'migrations'),
      path.resolve(__dirname, '..', '..', 'db', 'migrations'),
    ];
    return candidates.find((dir) => fs.existsSync(dir)) ?? null;
  }

  getScore(projectId: string): HealthScore | undefined {
    return this.engine.getCurrent(projectId);
  }

  getHistory(projectId: string): HealthScore[] {
    return this.engine.getHistory(projectId);
  }

  /**
   * 体检完成后将 guard + inspect 报告转化为健康维度分并落库。
   * 支持传统（GuardReport/InspectionReport）与 SOP（RuleEngineReport）两种格式；
   * 缺任一报告或格式混合时跳过并告警。评分失败不影响管线结果（不抛错）。
   */
  recordPipelineScore(projectPath: string, report: PipelineReport): HealthScore | null {
    this.initialize();
    try {
      const formats = resolveReportFormats(report);
      if (formats.kind === 'missing') {
        this.logger.warn(`跳过评分: 缺少 guard 或 inspect 报告 (${projectPath})`);
        return null;
      }
      if (formats.kind === 'mixed') {
        this.logger.warn(`跳过评分: 混合报告格式 (${projectPath})`);
        return null;
      }

      const dimensions = buildHealthDimensions(
        { results: formats.guardResults },
        { issues: formats.inspectIssues },
        projectPath,
        null,
      );
      const score = this.engine.calculate(projectPath, dimensions);
      this.logger.log(`健康评分已落库: ${projectPath} ${score.overall} (${score.grade})`);
      return score;
    } catch (err) {
      this.logger.warn(`健康评分落库失败: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  onModuleDestroy(): void {
    if (this.dbConn) {
      try {
        this.dbConn.close();
      } catch (err) {
        this.logger.warn(`关闭评分数据库失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.dbConn = null;
    }
  }
}

function isRuleEngineReport(r: unknown): r is { total: number; evaluations: unknown[] } {
  return !!r && typeof r === 'object' && 'total' in r && 'evaluations' in r;
}

type ReportFormatResult =
  | { kind: 'ok'; guardResults: ConvertedGuardResult[]; inspectIssues: ConvertedInspectIssue[] }
  | { kind: 'missing' }
  | { kind: 'mixed' };

/** 解析评分输入的报告格式：SOP/传统；缺报告或格式混合时返回跳过原因 */
function resolveReportFormats(report: PipelineReport): ReportFormatResult {
  const guardReport = report.guard;
  const inspectReport = report.inspect;
  if (!guardReport || !inspectReport) return { kind: 'missing' };

  const isSop = isRuleEngineReport(guardReport) && isRuleEngineReport(inspectReport);
  if (isSop) {
    return {
      kind: 'ok',
      guardResults: convertGuardEvaluations(guardReport.evaluations),
      inspectIssues: convertInspectEvaluations(inspectReport.evaluations),
    };
  }
  if (isRuleEngineReport(guardReport) || isRuleEngineReport(inspectReport))
    return { kind: 'mixed' };

  return {
    kind: 'ok',
    guardResults: (guardReport as GuardReport).results,
    inspectIssues: (inspectReport as InspectionReport).issues,
  };
}
