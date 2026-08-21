import { app } from 'electron';
import path from 'node:path';
import { DbConnection } from '@zh/db';
import { ScoringEngine } from '@zh/scoring';
import { GuardEngine } from '@zh/guard';
import type { CheckOptions, GuardReport } from '@zh/guard';
import { InspectEngine } from '@zh/inspect';
import type { InspectionReport } from '@zh/inspect';
import { SecurityEngine } from '@zh/security';
import type { SecurityScanReport } from '@zh/security';
import { EventBus } from '@zh/kernel';

export class EngineService {
  private db: ReturnType<DbConnection['connect']> | null = null;
  private conn: DbConnection | null = null;
  private scoring: ScoringEngine | null = null;
  private guard: GuardEngine | null = null;
  private inspect: InspectEngine | null = null;
  private security: SecurityEngine | null = null;
  private eventBus: EventBus | null = null;

  async init(): Promise<void> {
    const dbPath = path.join(app.getPath('userData'), 'zh-codeshield.db');
    this.conn = new DbConnection({ dbPath });
    const db = this.conn.connect();
    this.conn.migrate(path.join(__dirname, '..', 'packages', 'db', 'migrations'));

    this.db = db;
    this.eventBus = new EventBus();
    this.scoring = new ScoringEngine(db);
    this.guard = new GuardEngine(process.cwd(), undefined, {
      emit: (event) => this.eventBus!.emit(event.type, event.payload),
    });
    this.inspect = new InspectEngine({
      emit: (event) => this.eventBus!.emit(event.type, event.payload),
    });
    this.security = new SecurityEngine({
      emit: (event) => this.eventBus!.emit(event.type, event.payload),
    });
  }

  async runGuard(projectPath: string, options?: Partial<CheckOptions>): Promise<GuardReport> {
    if (!this.guard) throw new Error('EngineService not initialized');
    return this.guard.run({
      mode: 'guard',
      target: projectPath,
      ...options,
    });
  }

  async runInspect(projectPath: string): Promise<InspectionReport> {
    if (!this.inspect) throw new Error('EngineService not initialized');
    return this.inspect.runScan(projectPath, 'full');
  }

  async runSecurity(projectPath: string): Promise<SecurityScanReport> {
    if (!this.security) throw new Error('EngineService not initialized');
    return this.security.runSecurityScan(projectPath, projectPath);
  }

  getScore(projectId: string) {
    if (!this.scoring) throw new Error('EngineService not initialized');
    return this.scoring.getCurrent(projectId);
  }

  getScoreHistory(projectId: string) {
    if (!this.scoring) throw new Error('EngineService not initialized');
    return this.scoring.getHistory(projectId);
  }

  async destroy(): Promise<void> {
    this.db?.close();
    this.conn?.close();
  }
}
