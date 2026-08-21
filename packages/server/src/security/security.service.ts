import { Injectable, Logger } from '@nestjs/common';
import { SecurityEngine } from '@zh/security';
import type { SecurityScanReport } from '@zh/security';
import { EventBus } from '@zh/kernel';

@Injectable()
export class SecurityService {
  private readonly logger = new Logger(SecurityService.name);
  private engine: SecurityEngine;

  constructor() {
    const eventBus = new EventBus();
    this.engine = new SecurityEngine({
      emit: (event) => eventBus.emit(event.type, event.payload),
    });
  }

  async runScan(projectPath: string): Promise<SecurityScanReport> {
    this.logger.log(`Running security scan on: ${projectPath}`);
    return this.engine.runSecurityScan(projectPath, projectPath);
  }
}
