import { randomUUID } from 'node:crypto';
import { appendAuditLog, DbConnection } from '@zh/db';

/** 管理操作错误分类：validation → 400，not_found → 404，unavailable → 503 */
export type AdminErrorKind = 'validation' | 'not_found' | 'unavailable';

/** 仓库层抛出的管理操作错误（控制器/服务层翻译为 Nest HTTP 异常） */
export class AdminError extends Error {
  constructor(
    message: string,
    readonly kind: AdminErrorKind,
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

/** 审计写入参数：目标实体（规则/工具）、实体 ID、操作名与详情 */
export interface AuditParams {
  db: ReturnType<DbConnection['getDb']>;
  entityType: 'rule' | 'tool';
  entityId: string;
  action: string;
  detail: string;
}

/** 写审计日志（operator 恒为 admin，P0 无账号体系） */
export function audit(params: AuditParams): void {
  const { db, entityType, entityId, action, detail } = params;
  appendAuditLog(db, { id: randomUUID(), entityType, entityId, action, detail, operator: 'admin' });
}