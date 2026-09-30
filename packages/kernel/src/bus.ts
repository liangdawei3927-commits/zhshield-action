import { sanitizeLogField } from '@zh/shared';

type EventCallback<T = unknown> = (payload: T) => void | Promise<void>;

interface EventEntry {
  callback: EventCallback;
  once: boolean;
}

export class EventBus {
  private listeners = new Map<string, EventEntry[]>();
  // 内部存储使用 unknown（类型擦除），公共 API 通过泛型提供类型安全
  private requestHandlers = new Map<string, (payload: unknown) => Promise<unknown>>();

  on<T = unknown>(event: string, callback: EventCallback<T>): () => void {
    return this.addListener(event, callback as EventCallback, false);
  }

  once<T = unknown>(event: string, callback: EventCallback<T>): () => void {
    return this.addListener(event, callback as EventCallback, true);
  }

  /** 追加监听器（on / once 共用）：按事件维护监听数组并返回取消函数 */
  private addListener(event: string, callback: EventCallback, once: boolean): () => void {
    const entry: EventEntry = { callback, once };
    let list = this.listeners.get(event);
    if (list === undefined) {
      list = [];
      this.listeners.set(event, list);
    }
    list.push(entry);
    return () => this.off(event, callback);
  }

  off(event: string, callback: EventCallback): void {
    const entries = this.listeners.get(event);
    if (!entries) return;
    const idx = entries.findIndex((e) => e.callback === callback);
    if (idx !== -1) entries.splice(idx, 1);
  }

  async emit<T = unknown>(event: string, payload: T): Promise<void> {
    const entries = this.listeners.get(event);
    if (!entries || entries.length === 0) return;

    const toRemove: EventEntry[] = [];
    for (const entry of entries) {
      try {
        await entry.callback(payload);
      } catch (err) {
        console.error('[EventBus] Error in listener for "%s":', sanitizeLogField(event), err);
      }
      if (entry.once) toRemove.push(entry);
    }

    for (const entry of toRemove) {
      const idx = entries.indexOf(entry);
      if (idx !== -1) entries.splice(idx, 1);
    }
  }

  handleRequest<TRequest = unknown, TResponse = unknown>(
    event: string,
    handler: (payload: TRequest) => Promise<TResponse>,
  ): () => void {
    const erased: (payload: unknown) => Promise<unknown> = (payload: unknown) =>
      handler(payload as TRequest);
    this.requestHandlers.set(event, erased);
    return () => this.requestHandlers.delete(event);
  }

  async request<TRequest = unknown, TResponse = unknown>(
    event: string,
    payload: TRequest,
  ): Promise<TResponse> {
    const handler = this.requestHandlers.get(event);
    if (!handler) {
      throw new Error(`[EventBus] No handler registered for request "${event}"`);
    }
    return (await handler(payload)) as TResponse;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.listeners.delete(event);
      this.requestHandlers.delete(event);
    } else {
      this.listeners.clear();
      this.requestHandlers.clear();
    }
  }
}
