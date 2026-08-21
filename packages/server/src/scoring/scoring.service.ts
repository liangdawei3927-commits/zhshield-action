import { Injectable, Logger } from '@nestjs/common';
import { initDatabase } from '@zh/db';
import { ScoringEngine, buildHealthDimensions, type HealthScore } from '@zh/scoring';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import type { GuardReport } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';

/** HTTP 返回的序列化评分 — score 替代 overall，timestamp 为 ISO 字符串 */
export interface ScoreData {
  score: number;
  dimensions: HealthScore['dimensions'];
  summary: string;
  timestamp: string;
}

@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);
  private engine: ScoringEngine;

  constructor() {
    this.engine = new ScoringEngine();
  }

  /**
   * 启用 SQLite 持久化 — 用 db 支撑的引擎替换内存引擎，评分与历史可跨进程存活。
   * 初始化失败时保持内存模式，不阻断主流程。
   */
  async initialize(dbPath: string): Promise<void> {
    try {
      const db = initDatabase({ dbPath });
      this.engine = new ScoringEngine(db);
      this.logger.log(translate('server.scoring.persistenceEnabled', DEFAULT_LANGUAGE, { dbPath }));
    } catch (err) {
      this.logger.warn(
        translate('server.scoring.persistenceUnavailable', DEFAULT_LANGUAGE, {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  getScore(projectId: string): HealthScore | undefined {
    return this.engine.getCurrent(projectId);
  }

  getHistory(projectId: string): HealthScore[] {
    return this.engine.getHistory(projectId);
  }

  /** 体检完成后由 guard + inspect 报告生成并记录健康评分 */
  recordPipelineScore(
    projectId: string,
    guard: GuardReport,
    inspect: InspectionReport,
    locale?: LanguageCode,
  ): HealthScore {
    const dimensions = buildHealthDimensions(
      { results: guard.results },
      { issues: inspect.issues },
    );
    const score = this.engine.calculate(projectId, dimensions);
    this.logger.log(
      translate('server.scoring.scoreRecorded', locale ?? DEFAULT_LANGUAGE, {
        score: score.overall,
        grade: score.grade,
      }),
    );
    return score;
  }

  /** 归一化 HealthScore → HTTP 序列化结构（overall → score） */
  toScoreData(score: HealthScore): ScoreData {
    return {
      score: score.overall,
      dimensions: score.dimensions,
      summary: score.grade,
      timestamp: score.timestamp.toISOString(),
    };
  }
}
