import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../bus';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('should emit and receive events', async () => {
    const received: string[] = [];
    bus.on('test', (payload: string) => received.push(payload));
    await bus.emit('test', 'hello');
    expect(received).toEqual(['hello']);
  });

  it('should support multiple listeners', async () => {
    const received: string[] = [];
    bus.on('test', (p: string) => received.push('a:' + p));
    bus.on('test', (p: string) => received.push('b:' + p));
    await bus.emit('test', 'x');
    expect(received).toEqual(['a:x', 'b:x']);
  });

  it('should support once', async () => {
    let count = 0;
    bus.once('test', () => { count++; });
    await bus.emit('test', null);
    await bus.emit('test', null);
    expect(count).toBe(1);
  });

  it('should support off', async () => {
    let count = 0;
    const handler = () => { count++; };
    bus.on('test', handler);
    await bus.emit('test', null);
    bus.off('test', handler);
    await bus.emit('test', null);
    expect(count).toBe(1);
  });

  it('should support request/response', async () => {
    bus.handleRequest<number, string>('double', async (n) => String(n * 2));
    const result = await bus.request<number, string>('double', 21);
    expect(result).toBe('42');
  });

  it('should throw on missing request handler', async () => {
    await expect(bus.request('missing', null)).rejects.toThrow('No handler');
  });

  it('should return listener count', () => {
    bus.on('test', () => {});
    bus.on('test', () => {});
    expect(bus.listenerCount('test')).toBe(2);
  });

  it('should clear all listeners', () => {
    bus.on('a', () => {});
    bus.on('b', () => {});
    bus.removeAllListeners();
    expect(bus.listenerCount('a')).toBe(0);
    expect(bus.listenerCount('b')).toBe(0);
  });

  it('listener 抛错时日志注入防护：常量模板 + 事件名净化（剥离换行）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      bus.on('evil\nevent', () => {
        throw new Error('boom');
      });
      await bus.emit('evil\nevent', null);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [format, eventArg] = errorSpy.mock.calls[0] as [string, unknown];
      expect(format).toBe('[EventBus] Error in listener for "%s":');
      expect(String(eventArg)).not.toContain('\n');
      expect(String(eventArg)).not.toContain('\r');
      expect(String(eventArg)).toContain('evil event');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
