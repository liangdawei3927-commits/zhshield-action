import { Injectable, Logger } from '@nestjs/common';
import { ScoringEngine, type HealthScore } from '@zh/scoring';

@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);
  private engine: ScoringEngine;

  constructor() {
    this.engine = new ScoringEngine();
  }

  getScore(projectId: string): HealthScore | undefined {
    return this.engine.getCurrent(projectId);
  }

  getHistory(projectId: string): HealthScore[] {
    return this.engine.getHistory(projectId);
  }
}
