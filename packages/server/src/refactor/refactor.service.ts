import { Injectable, Logger } from '@nestjs/common';
import { RefactorEngine } from '@zh/refactor';
import type { RefactorReport } from '@zh/refactor';
import type { LanguageCode } from '@zh/i18n';

@Injectable()
export class RefactorService {
  private readonly logger = new Logger(RefactorService.name);
  private readonly engine: RefactorEngine;

  constructor() {
    this.engine = new RefactorEngine();
  }

  async scanDirectory(projectPath: string, locale?: LanguageCode): Promise<RefactorReport> {
    this.logger.log(`Running refactor scan on: ${projectPath}`);
    return this.engine.analyzeDirectory(projectPath, locale);
  }

  async scanStaged(projectPath: string, locale?: LanguageCode): Promise<RefactorReport> {
    this.logger.log(`Running staged refactor scan on: ${projectPath}`);
    return this.engine.analyzeStagedFiles(projectPath, locale);
  }
}
