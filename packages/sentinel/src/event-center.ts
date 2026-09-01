import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { SentinelEvent, EventStatus, EventSeverity, AlertPayload } from './types';
import type { SentinelEventRow } from '@zh/db';
import {
  createSentinelEvent,
  updateSentinelEvent,
  findSentinelEventByDedupeKey,
  getSentinelEvent,
} from '@zh/db';

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

  constructor(db?: Database.Database) {
    if (db) this.db = db;
  }

  setDb(db: Database.Database): void {
    this.db = db;
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

    if (this.isDuplicate(dedupeKey)) {
      const existing = this.findEventByDedupeKey(dedupeKey)!;
      existing.occurrenceCount += 1;
      existing.lastSeen = new Date();
      existing.history.push({
        timestamp: new Date(),
        action: 'alert-repeat',
        operator: 'system',
        detail: `Alert repeated (${existing.occurrenceCount} times)`,
      });
      this.persistUpdate(existing);
      return { event: existing, isNew: false };
    }

    const event: SentinelEvent = {
      id: randomUUID(),
      projectId: labels.repo || 'unknown',
      timestamp: new Date(),
      dedupeKey,
      title: firstAlert.annotations.summary || labels.alertname,
      service: labels.service,
      module: labels.module,
      severity: this.mapSeverity(labels.severity),
      status: 'detected',
      validation: { status: 'pending' },
      context: { ...labels },
      history: [
        {
          timestamp: new Date(),
          action: 'alert-received',
          operator: 'alertmanager',
          detail: `Alert received: ${labels.alertname}`,
        },
      ],
      occurrenceCount: 1,
      firstSeen: new Date(),
      lastSeen: new Date(),
    };

    this.events.set(event.id, event);
    this.persistEvent(event);
    return { event, isNew: true };
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
  }): SentinelEvent {
    const event: SentinelEvent = {
      id: randomUUID(),
      projectId: params.projectId,
      timestamp: new Date(),
      dedupeKey: `${params.projectId}|${params.title}|${Date.now()}`,
      title: params.title,
      service: params.service || '',
      module: params.module || '',
      severity: params.severity || 'p3',
      status: 'detected',
      validation: { status: 'pending' },
      context: (params.context || {}) as Record<string, unknown>,
      history: [
        {
          timestamp: new Date(),
          action: params.action || 'event-created',
          operator: params.operator || 'system',
          detail: params.detail || params.title,
        },
      ],
      occurrenceCount: 1,
      firstSeen: new Date(),
      lastSeen: new Date(),
    };

    this.events.set(event.id, event);
    this.persistEvent(event);
    return event;
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
    this.persistUpdate(event);
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
    this.persistUpdate(event);
    return event;
  }

  getEvent(eventId: string): SentinelEvent | undefined {
    return this.events.get(eventId) || this.loadFromDb(eventId);
  }

  listEvents(filters?: { status?: EventStatus; severity?: EventSeverity }): SentinelEvent[] {
    let results = [...this.events.values()];
    if (filters?.status) results = results.filter((e) => e.status === filters.status);
    if (filters?.severity) results = results.filter((e) => e.severity === filters.severity);
    return results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  private findEventByDedupeKey(dedupeKey: string): SentinelEvent | undefined {
    const found = [...this.events.values()].find((e) => e.dedupeKey === dedupeKey);
    if (found) return found;
    if (this.db) {
      const row = findSentinelEventByDedupeKey(this.db, dedupeKey);
      if (row) return this.rowToEvent(row);
    }
    return undefined;
  }

  private loadFromDb(eventId: string): SentinelEvent | undefined {
    if (!this.db) return undefined;
    const row = getSentinelEvent(this.db, eventId);
    if (!row) return undefined;
    const event = this.rowToEvent(row);
    this.events.set(event.id, event);
    return event;
  }

  private rowToEvent(row: SentinelEventRow): SentinelEvent {
    return {
      id: row.id,
      projectId: row.project_id,
      timestamp: new Date(row.timestamp),
      dedupeKey: row.dedupe_key,
      title: row.title,
      service: row.service,
      module: row.module,
      severity: row.severity as EventSeverity,
      status: row.status as EventStatus,
      validation: typeof row.validation === 'string' ? JSON.parse(row.validation) : row.validation,
      context: typeof row.context === 'string' ? JSON.parse(row.context) : row.context,
      history: typeof row.history === 'string' ? JSON.parse(row.history) : row.history,
      occurrenceCount: row.occurrence_count,
      firstSeen: new Date(row.first_seen),
      lastSeen: new Date(row.last_seen),
    };
  }

  private persistEvent(event: SentinelEvent): void {
    if (!this.db) return;
    try {
      createSentinelEvent(this.db, {
        id: event.id,
        projectId: event.projectId,
        timestamp: event.timestamp,
        dedupeKey: event.dedupeKey,
        title: event.title,
        service: event.service,
        module: event.module,
        severity: event.severity,
        status: event.status,
        validation: JSON.stringify(event.validation),
        context: JSON.stringify(event.context),
        history: JSON.stringify(event.history),
        occurrenceCount: event.occurrenceCount,
        firstSeen: event.firstSeen,
        lastSeen: event.lastSeen,
      });
    } catch (err) {
      console.error('[EventCenter] Failed to persist event:', err);
    }
  }

  private persistUpdate(event: SentinelEvent): void {
    if (!this.db) return;
    try {
      updateSentinelEvent(this.db, {
        id: event.id,
        status: event.status,
        validation: JSON.stringify(event.validation),
        history: JSON.stringify(event.history),
        occurrenceCount: event.occurrenceCount,
        lastSeen: event.lastSeen,
      });
    } catch (err) {
      console.error('[EventCenter] Failed to persist update:', err);
    }
  }

  private mapSeverity(raw: string): 'p1' | 'p2' | 'p3' {
    return SEVERITY_TO_PRIORITY.get(raw?.toLowerCase()) ?? 'p3';
  }
}
