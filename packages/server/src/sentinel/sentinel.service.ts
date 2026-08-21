import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventCenter, FileMonitor, ProcessMonitor, LogCollector, AutoFixer, DEFAULT_IGNORE_DIRS, defaultFileWatchFilter } from '@zh/sentinel';
import type { SentinelEvent, AlertPayload, EventStatus, EventSeverity } from '@zh/sentinel';
import { DbConnection } from '@zh/db';
import * as path from 'path';

@Injectable()
export class SentinelService implements OnModuleDestroy {
  private readonly logger = new Logger(SentinelService.name);
  private eventCenter: EventCenter;
  private fileMonitor: FileMonitor;
  private processMonitor: ProcessMonitor;
  private logCollector: LogCollector;
  private autoFixer: AutoFixer;
  private dbConn: DbConnection | null = null;

  constructor() {
    this.eventCenter = new EventCenter();
    this.fileMonitor = new FileMonitor(this.eventCenter);
    this.processMonitor = new ProcessMonitor(this.eventCenter);
    this.logCollector = new LogCollector(this.eventCenter);
    this.autoFixer = new AutoFixer(this.eventCenter);
  }

  async initialize(dbPath?: string): Promise<void> {
    if (dbPath) {
      try {
        this.dbConn = new DbConnection({ dbPath, walMode: true });
        const db = this.dbConn.connect();
        this.dbConn.migrate(
          path.join(path.dirname(dbPath), '..', 'migrations'),
        );
        this.eventCenter.setDb(db);
        this.logger.log('Sentinel persistence initialized');
      } catch {
        this.logger.warn('Sentinel persistence unavailable, running in-memory only');
      }
    }

    this.logger.log('Sentinel service initialized');
  }

  getEventCenter(): EventCenter {
    return this.eventCenter;
  }

  getFileMonitor(): FileMonitor {
    return this.fileMonitor;
  }

  getProcessMonitor(): ProcessMonitor {
    return this.processMonitor;
  }

  getLogCollector(): LogCollector {
    return this.logCollector;
  }

  getAutoFixer(): AutoFixer {
    return this.autoFixer;
  }

  processWebhook(token: string, payload: AlertPayload): { accepted: boolean; eventId?: string; reason?: string } {
    if (!this.isValidAlertPayload(payload)) {
      return { accepted: false, reason: 'invalid payload' };
    }

    const { event, isNew } = this.eventCenter.processAlert(payload);
    this.logger.log(`Webhook event ${isNew ? 'created' : 'deduped'}: ${event.id}`);

    this.triggerAutoFixIfNeeded(event, isNew);

    return { accepted: true, eventId: event.id };
  }

  private isValidAlertPayload(payload: unknown): payload is AlertPayload {
    // Validate payload shape
    return (
      !!payload &&
      typeof payload === 'object' &&
      'alerts' in payload &&
      Array.isArray((payload as { alerts?: unknown }).alerts)
    );
  }

  private triggerAutoFixIfNeeded(event: SentinelEvent, isNew: boolean): void {
    // Trigger auto-fixer on new events above threshold
    if (isNew && (event.severity === 'p1' || event.severity === 'p2')) {
      this.autoFixer.evaluateAndFix(event);
    }
  }

  listEvents(filters?: { status?: string; severity?: string }): SentinelEvent[] {
    return this.eventCenter.listEvents({
      status: filters?.status as EventStatus | undefined,
      severity: filters?.severity as EventSeverity | undefined,
    });
  }

  getEvent(id: string): SentinelEvent | undefined {
    return this.eventCenter.getEvent(id);
  }

  async startFileMonitor(projectId: string, watchPaths: string[]): Promise<void> {
    this.fileMonitor.start({
      projectId,
      watchPaths,
      intervalMs: 5000,
      ignoreDirs: DEFAULT_IGNORE_DIRS,
      filter: defaultFileWatchFilter,
    });
    this.logger.log(`File monitor started for ${projectId}: ${watchPaths.join(', ')}`);
  }

  async startProcessMonitor(projectId: string, command: string, cwd: string): Promise<void> {
    this.processMonitor.start({ projectId, command, cwd });
    this.logger.log(`Process monitor started for ${projectId}: ${command}`);
  }

  async startLogCollector(projectId: string, logPaths: string[]): Promise<void> {
    this.logCollector.start({ projectId, logPaths });
    this.logger.log(`Log collector started for ${projectId}: ${logPaths.join(', ')}`);
  }

  onModuleDestroy(): void {
    this.fileMonitor.stop();
    this.processMonitor.stop();
    this.logCollector.stop();
    this.autoFixer.stop();
    this.dbConn?.close();
    this.logger.log('Sentinel service shut down');
  }
}
