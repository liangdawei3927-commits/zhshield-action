import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../bus';
import type { KernelEventMap } from '@zh/shared';

interface TestEventMap extends KernelEventMap {
  'test:string': string;
  'test:null': null;
  'test:void': Record<string, never>;
  'double:number': number;
  'double:string': string;
  'request:missing': Record<string, never>;
}

describe('EventBus', () => {
  let bus: EventBus<TestEventMap>;

  beforeEach(() => {
    bus = new EventBus<TestEventMap>();
  });

  it('should emit and receive events', async () => {
    const received: string[] = [];
    bus.on('test:string', (payload) => received.push(payload));
    await bus.emit('test:string', 'hello');
    expect(received).toEqual(['hello']);
  });

  it('should support multiple listeners', async () => {
    const received: string[] = [];
    bus.on('test:string', (p) => received.push('a:' + p));
    bus.on('test:string', (p) => received.push('b:' + p));
    await bus.emit('test:string', 'x');
    expect(received).toEqual(['a:x', 'b:x']);
  });

  it('should support once', async () => {
    let count = 0;
    bus.once('test:null', () => { count++; });
    await bus.emit('test:null', null);
    await bus.emit('test:null', null);
    expect(count).toBe(1);
  });

  it('should support off', async () => {
    let count = 0;
    const handler = () => { count++; };
    bus.on('test:null', handler);
    await bus.emit('test:null', null);
    bus.off('test:null', handler);
    await bus.emit('test:null', null);
    expect(count).toBe(1);
  });

  it('should support request/response', async () => {
    bus.handleRequest<'double:number', 'double:string'>(
      'double:number',
      async (n) => String(n * 2),
    );
    const result = await bus.request<'double:number', 'double:string'>('double:number', 21);
    expect(result).toBe('42');
  });

  it('should throw on missing request handler', async () => {
    await expect(bus.request('request:missing', {})).rejects.toThrow('No handler');
  });

  it('should return listener count', () => {
    bus.on('test:void', () => {});
    bus.on('test:void', () => {});
    expect(bus.listenerCount('test:void')).toBe(2);
  });

  it('should clear all listeners', () => {
    bus.on('test:string', () => {});
    bus.on('test:null', () => {});
    bus.removeAllListeners();
    expect(bus.listenerCount('test:string')).toBe(0);
    expect(bus.listenerCount('test:null')).toBe(0);
  });
});

describe('EventBus typed with KernelEventMap', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('should accept KernelEventMap events with correct payload types', async () => {
    const received: unknown[] = [];
    bus.on('tool:executed', (payload) => {
      received.push(payload.tool);
    });
    await bus.emit('tool:executed', {
      tool: 'eslint',
      status: 'available',
      duration: 100,
      issueCount: 3,
      projectId: 'p1',
      timestamp: new Date(),
    });
    expect(received).toEqual(['eslint']);
  });

  it('should accept backup events with Record<string, never> payload', async () => {
    let called = false;
    bus.on('backup:request', () => { called = true; });
    await bus.emit('backup:request', {});
    expect(called).toBe(true);
  });

  it('should accept score:calculated with HealthScore payload', async () => {
    let score: number | undefined;
    bus.on('score:calculated', (payload) => { score = payload.overall; });
    await bus.emit('score:calculated', {
      projectId: 'p1',
      timestamp: new Date(),
      overall: 85,
      grade: 'B',
      dimensions: [],
      trend: 'stable',
    });
    expect(score).toBe(85);
  });
});

describe('EventBus custom generic', () => {
  interface MyEvents {
    'custom:a': number;
    'custom:b': string;
  }

  it('should work with a completely custom event map', async () => {
    const bus = new EventBus<MyEvents>();
    const received: number[] = [];
    bus.on('custom:a', (n) => received.push(n));
    await bus.emit('custom:a', 42);
    expect(received).toEqual([42]);
  });
});
