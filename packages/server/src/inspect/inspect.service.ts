import { Injectable, Logger } from '@nestjs/common';
import { InspectEngine } from '@zh/inspect';
import type { InspectionReport } from '@zh/inspect';
import { EventBus } from '@zh/kernel';
import { EventCenter, subscribeScopeViolations } from '@zh/sentinel';

@Injectable()
export class InspectService {
  private readonly logger = new Logger(InspectService.name);
  private engine: InspectEngine;

  constructor() {
    const eventBus = new EventBus();
    const eventCenter = new EventCenter();
    subscribeScopeViolations(eventBus, eventCenter);
    this.engine = new InspectEngine({
      emit: (event) => eventBus.emit(event.type, event.payload),
    });
  }

  async runScan(projectPath: string): Promise<InspectionReport> {
    this.logger.log(`Running inspect scan on: ${projectPath}`);
    return this.engine.runScan(projectPath, 'full');
  }
}
