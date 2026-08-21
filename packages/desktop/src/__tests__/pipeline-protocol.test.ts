import { describe, expect, it } from 'vitest';
import { serializePipelineReport } from '../../electron/pipeline-protocol';

describe('serializePipelineReport', () => {
  it('将 Date 转为 ISO 字符串，便于跨进程传输', () => {
    const report = {
      timestamp: new Date('2026-07-31T00:00:00.000Z'),
      passed: true,
      stage: 'complete',
      guard: null,
      inspect: null,
      refactor: null,
    };

    const serialized = serializePipelineReport(report) as typeof report & { timestamp: string };

    expect(serialized.timestamp).toBe('2026-07-31T00:00:00.000Z');
    expect(serialized.passed).toBe(true);
    expect(serialized.stage).toBe('complete');
    // 必须是纯 JSON，无 Date 实例
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
  });

  it('保留 error 字段', () => {
    const serialized = serializePipelineReport({
      timestamp: new Date(),
      passed: false,
      stage: 'failed',
      error: 'boom',
      guard: null,
      inspect: null,
      refactor: null,
    }) as { error: string };

    expect(serialized.error).toBe('boom');
  });
});
