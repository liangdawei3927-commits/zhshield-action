import { Injectable, Logger } from '@nestjs/common';
import { GuardEngine } from '@zh/guard';
import type { GuardReport, CheckOptions } from '@zh/guard';
import {
  GuardESLintCheckAdapter,
  GuardSensitiveInfoAdapter,
  ArchitectureBoundaryAdapter,
  TestRunnerAdapter,
  SecurityScanAdapter,
} from '@zh/guard';
import { EventBus } from '@zh/kernel';

@Injectable()
export class GuardService {
  private readonly logger = new Logger(GuardService.name);
  private engine: GuardEngine;

  constructor() {
    const eventBus = new EventBus();
    this.engine = new GuardEngine(process.cwd(), undefined, {
      emit: (event) => eventBus.emit(event.type, event.payload),
    });

    // Register all guard adapters (checks.json adapter field ↔ class mapping)
    this.engine.registerAdapter('eslint-check',          new GuardESLintCheckAdapter());
    this.engine.registerAdapter('sensitive-info',         new GuardSensitiveInfoAdapter());
    this.engine.registerAdapter('architecture-boundary',  new ArchitectureBoundaryAdapter());
    this.engine.registerAdapter('test-runner',            new TestRunnerAdapter());
    this.engine.registerAdapter('security-scan',          new SecurityScanAdapter());
  }

  async runCheck(projectPath: string, options?: Partial<CheckOptions>): Promise<GuardReport> {
    this.logger.log(`Running guard check on: ${projectPath}`);
    return this.engine.run({
      mode: 'guard',
      target: projectPath,
      ...options,
    });
  }
}
