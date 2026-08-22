import { describe, it, expect } from 'vitest';
import { AuditLogger } from '../index';
import type { AuditEntry, AuditQuery, AuditStats } from '../index';

describe('kernel index 导出 audit 模块（二.2 遗留项）', () => {
  it('AuditLogger 可从包入口导入且可实例化', () => {
    expect(typeof AuditLogger).toBe('function');
    const logger = new AuditLogger('/tmp/zh-audit-export-proof');
    expect(logger).toBeInstanceOf(AuditLogger);
  });

  it('审计类型可从包入口导入（编译期证明）', () => {
    const entry: AuditEntry = {
      id: 'audit_1',
      timestamp: new Date(),
      action: 'export-proof',
      userId: 'tester',
      details: {},
      previousHash: '',
      hash: '',
    };
    const query: AuditQuery = { action: 'export-proof', limit: 1 };
    const stats: AuditStats = {
      totalEntries: 0,
      byAction: {},
      byUser: {},
      dateRange: null,
    };
    expect(query.action).toBe(entry.action);
    expect(stats.totalEntries).toBe(0);
  });
});
