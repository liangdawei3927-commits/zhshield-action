import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../bus';
import { EventCenter } from '../../sentinel/src/event-center';
import { AlertHandler } from '../../sentinel/src/alert-handler';
import type { AlertPayload } from '../../sentinel/src/types';
import { ScoringEngine } from '../../scoring/src/engine';
import type { DimensionScore, HealthScore } from '../../scoring/src/types';
import { EvolveEngine } from '../../evolve/src/engine';
import { InspectEngine } from '../../inspect/src/engine';

describe('Module Integration', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('EventBus + Sentinel: alert triggers event', async () => {
    const eventCenter = new EventCenter();
    const handler = new AlertHandler(eventCenter, 'test-token');

    const payload: AlertPayload = {
      receiver: 'webhook',
      status: 'firing',
      commonLabels: { alertname: 'TestAlert', service: 'api', module: 'test', severity: 'high', repo: 'test-repo', branch: 'main', actor: 'ci', pullRequestNumber: '', runbook: '', instance: '' },
      commonAnnotations: { summary: 'Test alert', description: 'Integration test' },
      alerts: [{ status: 'firing', labels: { alertname: 'TestAlert', service: 'api', module: 'test', severity: 'high', repo: 'test-repo', branch: 'main', actor: 'ci', pullRequestNumber: '', instance: 'test' }, annotations: { summary: 'Test', description: 'Test' }, fingerprint: 'fp-001' }],
    };

    const result = handler.handleWebhook('test-token', payload);
    expect(result.accepted).toBe(true);
    expect(result.eventId).toBeDefined();

    const event = eventCenter.getEvent(result.eventId!);
    expect(event).toBeDefined();
    expect(event!.title).toBe('Test');
    expect(event!.severity).toBe('p2');
  });

  it('ScoringEngine + EventBus: score triggers event', async () => {
    const engine = new ScoringEngine();
    const scored: HealthScore[] = [];
    bus.on('score:calculated', (s: HealthScore) => scored.push(s));

    const dims: DimensionScore[] = [
      { name: 'code-quality', weight: 0.4, score: 85, issues: 3 },
      { name: 'security', weight: 0.3, score: 92, issues: 1 },
      { name: 'test-coverage', weight: 0.3, score: 78, issues: 5 },
    ];
    const score = engine.calculate('proj-1', dims);
    bus.emit('score:calculated', score);

    expect(scored.length).toBe(1);
    expect(scored[0].overall).toBeGreaterThan(0);
  });

  it('EvolveEngine: record and suggest', () => {
    const engine = new EvolveEngine();

    engine.recordExperience({ projectId: 'p1', type: 'true-positive', ruleId: 'R1', pattern: 'x', message: 'ok', feedback: '', source: 'user', confidence: 1, verified: true });
    engine.recordExperience({ projectId: 'p1', type: 'true-positive', ruleId: 'R1', pattern: 'x', message: 'ok', feedback: '', source: 'user', confidence: 1, verified: true });
    engine.recordExperience({ projectId: 'p1', type: 'false-positive', ruleId: 'R2', pattern: 'y', message: 'bad', feedback: '', source: 'user', confidence: 0, verified: false });
    engine.recordExperience({ projectId: 'p1', type: 'false-positive', ruleId: 'R2', pattern: 'y', message: 'bad', feedback: '', source: 'user', confidence: 0, verified: false });
    engine.recordExperience({ projectId: 'p1', type: 'false-positive', ruleId: 'R2', pattern: 'y', message: 'bad', feedback: '', source: 'user', confidence: 0, verified: false });

    const suggestions = engine.getSuggestions('p1');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].ruleId).toBe('R2');
  });

  it('InspectEngine: scan produces report', async () => {
    const engine = new InspectEngine();
    engine.registerAdapter({
      id: 'test-adapter',
      name: 'Test',
      run: async () => [
        { id: '1', ruleId: 'T1', severity: 'warning', category: 'quality', message: 'test issue', file: 'test.ts', autoFixable: false, source: 'test', fingerprint: 'fp1' },
      ],
    });

    const report = await engine.runScan('proj-1');
    expect(report.issues.length).toBe(1);
    expect(report.score.grade).toBeDefined();
  });
});
