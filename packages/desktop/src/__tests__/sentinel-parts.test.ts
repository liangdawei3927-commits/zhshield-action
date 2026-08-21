import { describe, expect, it } from 'vitest';
import { eventToAiFixIssue, eventToFalsePositiveItem } from '../pages/sentinel-parts';
import { statusToStage, EVENT_LIFECYCLE_STEPS } from '../pages/sentinel-logic';

describe('eventToAiFixIssue 哨兵事件转 AI 问题', () => {
  it('maps event fields into AiFixIssue', () => {
    const issue = eventToAiFixIssue({
      id: 'e1',
      title: 'Log match: uncaught-exception',
      type: 'crash',
      severity: 'high',
      source: 'sentinel',
      status: 'detected',
      occurrenceCount: 3,
      lastSeen: '2026-08-07T08:00:00.000Z',
      context: {
        pattern: 'uncaught-exception',
        matchedLine: 'uncaughtException: boom',
        location: { module: 'order', file: 'src/modules/order/order.service.ts', line: 42, column: 15 },
      },
      diagnosis: { suggestion: '初始化前判空' },
    });

    expect(issue.source).toBe('哨兵·监控');
    expect(issue.ruleId).toBe('uncaught-exception');
    expect(issue.severity).toBe('high');
    expect(issue.file).toBe('src/modules/order/order.service.ts');
    expect(issue.line).toBe(42);
    expect(issue.column).toBe(15);
    expect(issue.message).toBe('uncaughtException: boom');
    expect(issue.suggestion).toBe('初始化前判空');
  });

  it('appends stack frames to message for crash events', () => {
    const issue = eventToAiFixIssue({
      id: 'e2',
      title: 'Log match: crash',
      type: 'crash',
      severity: 'critical',
      source: 'sentinel',
      status: 'detected',
      occurrenceCount: 1,
      lastSeen: '2026-08-07T08:00:00.000Z',
      context: {
        pattern: 'crash',
        matchedLine: 'FATAL: boom',
        stack: 'FATAL: boom\n    at main (/app/dist/server.js:2:15)',
      },
    });

    expect(issue.message).toContain('FATAL: boom');
    expect(issue.message).toContain('堆栈:');
    expect(issue.message).toContain('/app/dist/server.js:2:15');
  });

  it('falls back to title and type when context is missing', () => {
    const issue = eventToAiFixIssue({
      id: 'e3',
      title: 'Timeout detected',
      type: 'timeout',
      severity: 'low',
      source: 'sentinel',
      status: 'passed',
      occurrenceCount: 1,
      lastSeen: '2026-08-07T08:00:00.000Z',
    });

    expect(issue.ruleId).toBe('timeout');
    expect(issue.message).toBe('Timeout detected');
    expect(issue.file).toBeUndefined();
    expect(issue.suggestion).toBeUndefined();
  });

  it('文件监控事件（无 pattern/type）回退 sentinel-event，不产生 undefined', () => {
    const issue = eventToAiFixIssue({
      id: 'e4',
      title: 'File change: GuardPage.tsx',
      severity: 'p3',
      source: 'sentinel',
      status: 'detected',
      occurrenceCount: 1,
      lastSeen: '2026-08-07T08:00:00.000Z',
    });

    expect(issue.ruleId).toBe('sentinel-event');
    expect(issue.message).toBe('File change: GuardPage.tsx');
  });
});

describe('eventToFalsePositiveItem 哨兵事件转误报反馈', () => {
  it('maps event fields into false positive feedback item', () => {
    const item = eventToFalsePositiveItem({
      id: 'e1',
      title: 'Log match: uncaught-exception',
      type: 'crash',
      severity: 'high',
      source: 'sentinel',
      status: 'detected',
      occurrenceCount: 3,
      lastSeen: '2026-08-07T08:00:00.000Z',
      context: {
        pattern: 'uncaught-exception',
        matchedLine: 'uncaughtException: boom',
        location: { module: 'order', file: 'src/modules/order/order.service.ts', line: 42, column: 15 },
      },
    });

    expect(item.source).toBe('sentinel');
    expect(item.ruleId).toBe('uncaught-exception');
    expect(item.title).toBe('Log match: uncaught-exception');
    expect(item.message).toBe('uncaughtException: boom');
    expect(item.severity).toBe('high');
    expect(item.file).toBe('src/modules/order/order.service.ts');
    expect(item.line).toBe(42);
  });

  it('falls back to type/title/location when context is missing', () => {
    const item = eventToFalsePositiveItem({
      id: 'e3',
      title: 'Timeout detected',
      type: 'timeout',
      severity: 'low',
      source: 'sentinel',
      status: 'passed',
      occurrenceCount: 1,
      lastSeen: '2026-08-07T08:00:00.000Z',
      location: { file: 'src/main.ts', line: 7 },
    });

    expect(item.ruleId).toBe('timeout');
    expect(item.message).toBe('Timeout detected');
    expect(item.file).toBe('src/main.ts');
    expect(item.line).toBe(7);
  });

  it('文件监控事件（无 pattern/type）回退 sentinel-event', () => {
    const item = eventToFalsePositiveItem({
      id: 'e5',
      title: 'File change: app.spec.ts',
      severity: 'p3',
      source: 'sentinel',
      status: 'detected',
      occurrenceCount: 1,
      lastSeen: '2026-08-07T08:00:00.000Z',
    });

    expect(item.ruleId).toBe('sentinel-event');
    expect(item.title).toBe('File change: app.spec.ts');
  });
});

describe('statusToStage 事件闭环阶段映射', () => {
  it('生命周期共四个阶段：发现 → 修复 → 验证 → 归档', () => {
    expect(EVENT_LIFECYCLE_STEPS.map((s) => s.key)).toEqual(['detect', 'fix', 'validate', 'archive']);
  });

  it('检测态落在发现阶段', () => {
    expect(statusToStage('detected')).toBe('detect');
  });

  it('分派/修复/已提PR 均落在修复阶段', () => {
    expect(statusToStage('assigned')).toBe('fix');
    expect(statusToStage('fixing')).toBe('fix');
    expect(statusToStage('pr_opened')).toBe('fix');
    expect(statusToStage('manual_taken_over')).toBe('fix');
  });

  it('验证中落在验证阶段，验证失败停留在验证阶段', () => {
    expect(statusToStage('validating')).toBe('validate');
    expect(statusToStage('failed')).toBe('validate');
  });

  it('已解决/已合并/已上线/已回滚 完成闭环进入归档阶段', () => {
    expect(statusToStage('passed')).toBe('archive');
    expect(statusToStage('merged')).toBe('archive');
    expect(statusToStage('deployed')).toBe('archive');
    expect(statusToStage('rolled_back')).toBe('archive');
  });

  it('未知状态回退到发现阶段', () => {
    expect(statusToStage('unknown-state')).toBe('detect');
  });
});
