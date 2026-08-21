import { Injectable, Logger } from '@nestjs/common';
import { RefactorEngine } from '@zh/refactor';
import type { RefactorReport } from '@zh/refactor';

@Injectable()
export class RefactorService {
  private readonly logger = new Logger(RefactorService.name);
  private readonly engine: RefactorEngine;

  constructor() {
    this.engine = new RefactorEngine();
  }

  async scanDirectory(projectPath: string): Promise<RefactorReport> {
    this.logger.log(`Running refactor scan on: ${projectPath}`);
    return this.engine.analyzeDirectory(projectPath);
  }

  async scanStaged(projectPath: string): Promise<RefactorReport> {
    this.logger.log(`Running staged refactor scan on: ${projectPath}`);
    return this.engine.analyzeStagedFiles(projectPath);
  }
}
