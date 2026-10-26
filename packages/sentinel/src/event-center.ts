import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { SentinelEvent, EventStatus, EventSeverity, AlertPayload } from './types';
import { findSentinelEventByDedupeKey, getSentinelEvent } from '@zh/db';
import type { AuditLogger } from '@zh/shared';
import { listMergedEvents, rowToEvent, type EventFilters } from './event-list';
import { persistNewEvent, persistEventUpdate } from './event-persist';

/** 告警 severity → 事件优先级映射表（替代 mapSeverity 中的 switch 分派） */
const SEVERITY_TO_PRIORITY = new Map<string, 'p1' | 'p2' | 'p3'>([
  ['critical', 'p1'],
  ['high', 'p2'],
  ['warning', 'p3'],
  ['medium', 'p3'],
]);

export class EventCenter {
  private events = new Map<string, SentinelEvent>();
  private dedupeWindowMs = 10 * 60 * 1000;
  private db: Database.Database | null = null;
  private auditLogger: AuditLogger | null = null;

  constructor(db?: Database.Database, auditLogger?: AuditLogger) {
    if (db) this.db = db;
    if (auditLogger) this.auditLogger = auditLogger;
  }

  setDb(db: Database.Database): void {
    this.db = db;
  }

  setAuditLogger(auditLogger: AuditLogger): void {
    this.auditLogger = auditLogger;
  }

  generateDedupeKey(alert: AlertPayload['alerts'][0], labels: Record<string, string>): string {
    const parts = [
      alert.fingerprint,
      labels.alertname,
      labels.service,
      labels.module,
      labels.severity,
    ];
    return parts.join('|');
  }

  isDuplicate(dedupeKey: string): boolean {
    const existing = this.findEventByDedupeKey(dedupeKey);
    if (!existing) return false;
    const elapsed = Date.now() - existing.lastSeen.getTime();
    return elapsed < this.dedupeWindowMs;
  }

  processAlert(payload: AlertPayload): { event: SentinelEvent; isNew: boolean } {
    const firstAlert = payload.alerts[0];
    const labels = firstAlert.labels;
    const dedupeKey = this.generateDedupeKey(firstAlert, labels);

    const repeated = this.mergeIntoExisting(dedupeKey, 'alert-repeat', 'system', 'Alert');
    if (repeated) return { event: repeated, isNew: false };

    const event = this.buildEvent({
      projectId: labels.repo || 'unknown',
      dedupeKey,
      title: firstAlert.annotations.summary || labels.alertname,
      service: labels.service,
      module: labels.module,
      severity: this.mapSeverity(labels.severity),
      context: { ...labels },
      action: 'alert-received',
      operator: 'alertmanager',
      detail: `Alert received: ${labels.alertname}`,
    });
    return { event: this.persistCreated(event, 'alert-received'), isNew: true };
  }

  createEvent(params: {
    projectId: string;
    title: string;
    service?: string;
    module?: string;
    severity?: EventSeverity;
    context?: Record<string, unknown>;
    operator?: string;
    action?: string;
    detail?: string;
    /** 显式稳定去重键：提供时复用 10 分钟去重窗口，同键重复事件合并为 occurrenceCount 递增（防事件风暴）。
     *  不提供时保持历史行为（每次新建独立事件）。 */
    dedupeKey?: string;
  }): SentinelEvent {
    // 内部事件去重：显式稳定键且在去重窗口内的重复事件合并，而非新建行。
    if (params.dedupeKey) {
      const repeated = this.mergeIntoExisting(
        params.dedupeKey,
        'event-repeat',
        params.operator || 'system',
        'Event',
      );
      if (repeated) {
        this.writeAuditLog('event-repeat', repeated);
        return repeated;
      }
    }

    const event = this.buildEvent({
      projectId: params.projectId,
      dedupeKey: params.dedupeKey ?? `${params.projectId}|${params.title}|${Date.now()}`,
      title: params.title,
      service: params.service || '',
      module: params.module || '',
      severity: params.severity || 'p3',
      context: (params.context || {}) as Record<string, unknown>,
      action: params.action || 'event-created',
      operator: params.operator || 'system',
      detail: params.detail || params.title,
    });
    return this.persistCreated(event, 'event-created');
  }

  /**
   * 新建事件的公共构造：`processAlert` 与 `createEvent` 的字段**取值**不同，
   * 但事件**结构**完全一致，原先各写一遍、改一处漏一处。这里统一收敛。
   */
  private buildEvent(input: {
    projectId: string;
    dedupeKey: string;
    title: string;
    service: string;
    module: string;
    severity: EventSeverity;
    context: Record<string, unknown>;
    action: string;
    operator: string;
    detail: string;
  }): SentinelEvent {
    return {
      id: randomUUID(),
      projectId: input.projectId,
      timestamp: new Date(),
      dedupeKey: input.dedupeKey,
      title: input.title,
      service: input.service,
      module: input.module,
      severity: input.severity,
      status: 'detected',
      validation: { status: 'pending' },
      context: input.context,
      history: [
        {
          timestamp: new Date(),
          action: input.action,
          operator: input.operator,
          detail: input.detail,
        },
      ],
      occurrenceCount: 1,
      firstSeen: new Date(),
      lastSeen: new Date(),
    };
  }

  /** 新建路径的公共尾段：入内存 → 落库 → 写审计 */
  private persistCreated(event: SentinelEvent, auditAction: string): SentinelEvent {
    this.events.set(event.id, event);
    persistNewEvent(this.db, event);
    this.writeAuditLog(auditAction, event);
    return event;
  }

  /**
   * 合并到已有事件：命中去重窗口则 `occurrenceCount` 递增并追加一条 repeat 历史，
   * 返回已有事件；未命中返回 null，由调用方按新建处理。
   *
   * `subject` 只决定历史文案前缀（Alert / Event）。审计**不在这里写**：
   * 告警重复与内部事件重复的审计口径不同（前者收到时已写过，不重复写），
   * 保留给调用方决定。
   */
  private mergeIntoExisting(
    dedupeKey: string,
    action: 'alert-repeat' | 'event-repeat',
    operator: string,
    subject: 'Alert' | 'Event',
  ): SentinelEvent | null {
    if (!this.isDuplicate(dedupeKey)) return null;
    const existing = this.findEventByDedupeKey(dedupeKey)!;
    existing.occurrenceCount += 1;
    existing.lastSeen = new Date();
    existing.history.push({
      timestamp: new Date(),
      action,
      operator,
      detail: `${subject} repeated (${existing.occurrenceCount} times)`,
    });
    persistEventUpdate(this.db, existing);
    return existing;
  }

  updateStatus(
    eventId: string,
    status: EventStatus,
    operator: string = 'system',
  ): SentinelEvent | null {
    const event = this.events.get(eventId) || this.loadFromDb(eventId);
    if (!event) return null;
    const prev = event.status;
    event.status = status;
    event.history.push({
      timestamp: new Date(),
      action: `status-changed:${prev}->${status}`,
      operator,
      detail: `Status changed from ${prev} to ${status}`,
    });
    this.events.set(event.id, event);
    persistEventUpdate(this.db, event);
    this.writeAuditLog('status-changed', event);
    return event;
  }

  updateValidation(
    eventId: string,
    result: 'pass' | 'fail',
    source?: string,
  ): SentinelEvent | null {
    const event = this.events.get(eventId) || this.loadFromDb(eventId);
    if (!event) return null;
    event.validation = { status: result, source, summary: `Validation ${result}` };
    event.history.push({
      timestamp: new Date(),
      action: 'validation-updated',
      operator: source || 'system',
      detail: `Validation result: ${result}`,
    });
    this.events.set(event.id, event);
    persistEventUpdate(this.db, event);
    this.writeAuditLog('validation-updated', event);
    return event;
  }

  getEvent(eventId: string): SentinelEvent | undefined {
    return this.events.get(eventId) || this.loadFromDb(eventId);
  }

  /**
   * 事件列表：**DB 为准，内存覆盖同 id**，按时间倒序。
   *
   * 实现在 `event-list.ts`（纯函数，可单独测）。核心事实：原先只返回内存 Map
   * 里的条目，进程一重启库里几百条事件就全都读不到了（实测本项目 338 条），
   * 哨兵页因此显示空白、详情入口消失。
   */
  listEvents(filters?: EventFilters): SentinelEvent[] {
    return listMergedEvents(this.db, this.events, filters);
  }

  private findEventByDedupeKey(dedupeKey: string): SentinelEvent | undefined {
    const found = [...this.events.values()].find((e) => e.dedupeKey === dedupeKey);
    if (found) return found;
    if (this.db) {
      const row = findSentinelEventByDedupeKey(this.db, dedupeKey);
      if (row) return rowToEvent(row);
    }
    return undefined;
  }

  private loadFromDb(eventId: string): SentinelEvent | undefined {
    if (!this.db) return undefined;
    const row = getSentinelEvent(this.db, eventId);
    if (!row) return undefined;
    const event = rowToEvent(row);
    this.events.set(event.id, event);
    return event;
  }

  private writeAuditLog(action: string, event: SentinelEvent): void {
    if (!this.auditLogger) return;
    this.auditLogger
      .logToolExecution({
        tool: 'sentinel',
        duration: 0,
        fileCount: 0,
        issueCount: 1,
        status: event.severity === 'p1' ? 'warning' : 'success',
        projectId: event.projectId,
      })
      .catch(() => {});
  }

  private mapSeverity(raw: string): 'p1' | 'p2' | 'p3' {
    return SEVERITY_TO_PRIORITY.get(raw?.toLowerCase()) ?? 'p3';
  }
}
