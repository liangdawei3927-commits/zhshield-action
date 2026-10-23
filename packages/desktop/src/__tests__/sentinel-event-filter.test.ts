import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventSeverity, SentinelEvent } from '@zh/sentinel';

/**
 * 跨传输层的同一不变量：`excludeInformational` 必须同时作用于 HTTP 与 IPC。
 * 打包版 Electron 走 IPC（isHttpMode 依赖构建期 VITE_API_BASE），浏览器开发版走 HTTP；
 * 两条路径若不一致，用户与开发看到的事件列表会分叉。
 */

const { handlers, listEvents } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, options?: unknown) => Promise<unknown>>(),
  listEvents: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, options?: unknown) => Promise<unknown>) => {
      handlers.set(channel, handler);
    },
  },
  app: { getPath: () => '/tmp/zh-sentinel-filter-test' },
}));

vi.mock('../../electron/ipc-context', () => ({
  getSentinel: async () => ({ eventCenter: { listEvents } }),
  stopAllMonitoring: vi.fn(),
}));

import { getSentinelEventsViaHttp } from '../services/serverApi';
import { registerSentinelIpc } from '../../electron/ipc/sentinel';

const AT = new Date('2026-10-21T07:50:00.000Z');

function makeEvent(id: string, severity: EventSeverity, action: string): SentinelEvent {
  return {
    id,
    projectId: 'proj-test',
    timestamp: AT,
    dedupeKey: `key-${id}`,
    title: `event ${id}`,
    service: 'sentinel',
    module: 'file-monitor',
    severity,
    status: 'detected',
    validation: { status: 'pending' },
    context: {},
    history: [{ timestamp: AT, action, operator: 'sentinel', detail: '' }],
    occurrenceCount: 1,
    firstSeen: AT,
    lastSeen: AT,
  };
}

const FILE_ADDED = makeEvent('e-add', 'p3', 'file-add');
const FILE_CHANGED = makeEvent('e-change', 'p3', 'file-change');
const FILE_DELETED = makeEvent('e-unlink', 'p2', 'file-unlink');
const PROCESS_DIED = makeEvent('e-exit', 'p2', 'process-exited');

function handlerFor(channel: string): (event: unknown, options?: unknown) => Promise<unknown> {
  const found = handlers.get(channel);
  if (found === undefined) throw new Error(`未注册 IPC channel: ${channel}`);
  return found;
}

describe('IPC sentinel:getEvents 的 excludeInformational', () => {
  beforeEach(() => {
    handlers.clear();
    listEvents.mockReset();
    listEvents.mockReturnValue([FILE_ADDED, FILE_CHANGED, FILE_DELETED, PROCESS_DIED]);
    registerSentinelIpc();
  });

  it('要求排除信息类事件时，只留下需人工处置的信号', async () => {
    const events = await handlerFor('sentinel:getEvents')(null, { excludeInformational: true });
    expect(events).toEqual([FILE_DELETED, PROCESS_DIED]);
  });

  it('未要求时返回全部事件（保持事件查询通道的原始语义）', async () => {
    const events = await handlerFor('sentinel:getEvents')(null, undefined);
    expect(events).toEqual([FILE_ADDED, FILE_CHANGED, FILE_DELETED, PROCESS_DIED]);
  });
});

describe('getSentinelEventsViaHttp 的 excludeInformational', () => {
  const requestedUrls: string[] = [];

  beforeEach(() => {
    requestedUrls.length = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      requestedUrls.push(url);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: [] }),
      };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function onlyRequestedQuery(): URLSearchParams {
    const first = requestedUrls[0];
    if (first === undefined) throw new Error('fetch 未被调用');
    return new URL(first).searchParams;
  }

  it('要求排除信息类事件时下发 excludeInformational=true 交给服务端过滤', async () => {
    await getSentinelEventsViaHttp({ excludeInformational: true });
    expect(onlyRequestedQuery().get('excludeInformational')).toBe('true');
  });

  it('未要求时不下发该参数（服务端默认返回全部事件）', async () => {
    await getSentinelEventsViaHttp();
    expect(onlyRequestedQuery().has('excludeInformational')).toBe(false);
  });
});
