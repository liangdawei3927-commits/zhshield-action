import { Injectable, Logger } from '@nestjs/common';
import { InspectEngine } from '@zh/inspect';
import type { InspectionReport } from '@zh/inspect';
import {
  ESLintAdapter,
  GitleaksAdapter,
  DependencyCruiserAdapter,
  JscpdAdapter,
  TsPruneAdapter,
  SemgrepAdapter,
  DepcheckAdapter,
  TypeScriptAdapter,
  PrettierAdapter,
  CommitLintAdapter,
  NpmAuditAdapter,
} from '@zh/inspect';
import { EventBus } from '@zh/kernel';
import { EventCenter, subscribeScopeViolations } from '@zh/sentinel';

/**
 * inspect 域内置适配器注册表。
 * 未注册任何适配器时 runDirectScan 无检查器可跑，报告恒为空——等于"声称体检过但没查"。
 * 该清单须与 scripts/zhcheck.mjs 的 INSPECT_ADAPTERS、pipeline-runner 的
 * registerDefaultAdapters 保持同步（后者的 pipeline 专属项不在此列）。
 */
const INSPECT_ADAPTERS = [
  ESLintAdapter,
  GitleaksAdapter,
  DependencyCruiserAdapter,
  JscpdAdapter,
  TsPruneAdapter,
  SemgrepAdapter,
  DepcheckAdapter,
  TypeScriptAdapter,
  PrettierAdapter,
  CommitLintAdapter,
  NpmAuditAdapter,
] as const;

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
    for (const Adapter of INSPECT_ADAPTERS) {
      this.engine.registerAdapter(new Adapter());
    }
  }

  async runScan(projectPath: string): Promise<InspectionReport> {
    this.logger.log(`Running inspect scan on: ${projectPath}`);
    return this.engine.runScan(projectPath, 'full');
  }
}
