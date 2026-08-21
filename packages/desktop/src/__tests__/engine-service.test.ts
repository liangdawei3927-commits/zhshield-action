import { describe, expect, it } from 'vitest';
import { serializePipelineReport } from '../../electron/pipeline-protocol';

describe('EngineService IPC contract', () => {
  it('serializes engine reports without Date instances', () => {
    const payload = serializePipelineReport({
      summary: { totalChecks: 3, passed: 2, blocked: 1, warnings: 0 },
      metadata: { duration: 12, timestamp: new Date('2026-07-31T08:00:00.000Z') },
    }) as {
      summary: { totalChecks: number };
      metadata: { timestamp: string };
    };

    expect(payload.summary.totalChecks).toBe(3);
    expect(payload.metadata.timestamp).toBe('2026-07-31T08:00:00.000Z');
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it('preserves nested null engine sections', () => {
    const payload = serializePipelineReport({
      guard: null,
      inspect: null,
      security: null,
    }) as Record<string, unknown>;

    expect(payload.guard).toBeNull();
    expect(payload.inspect).toBeNull();
    expect(payload.security).toBeNull();
  });
});
