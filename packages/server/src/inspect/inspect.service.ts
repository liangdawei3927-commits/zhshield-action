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
  TypeScriptAdapter,
  PrettierAdapter,
  CommitLintAdapter,
} from '@zh/inspect';
import { EventBus } from '@zh/kernel';
import { EventCenter, subscribeScopeViolations } from '@zh/sentinel';

/**
 * inspect 域内置适配器注册表。
 * 未注册任何适配器时 runDirectScan 无检查器可跑，报告恒为空——等于"声称体检过但没查"。
 * 该清单须与 scripts/zhcheck.mjs 的 INSPECT_ADAPTERS、pipeline-runner 的
 * registerDefaultAdapters 保持同步（后者的 pipeline 专属项不在此列）。
 * 《07》O7/O10：未使用依赖（depcheck）与依赖审计（npm-audit）的唯一 Owner 分别是
 * 垃圾清理与依赖管家，故不在此处注册——体检直扫不再产出这两类结论。
 */
const INSPECT_ADAPTERS = [
  ESLintAdapter,
  GitleaksAdapter,
  DependencyCruiserAdapter,
  JscpdAdapter,
  TsPruneAdapter,
  SemgrepAdapter,
  TypeScriptAdapter,
  PrettierAdapter,
  CommitLintAdapter,
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
