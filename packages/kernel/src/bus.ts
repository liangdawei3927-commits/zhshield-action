import type { KernelEventMap } from '@zh/shared';

type EventCallback<T = unknown> = (payload: T) => void | Promise<void>;

interface EventEntry {
  callback: EventCallback;
  once: boolean;
}

export class EventBus<Events extends object = KernelEventMap> {
  private listeners = new Map<keyof Events & string, EventEntry[]>();
  private requestHandlers = new Map<keyof Events & string, (payload: unknown) => Promise<unknown>>();

  on<K extends keyof Events & string>(event: K, callback: EventCallback<Events[K]>): () => void {
    const entry: EventEntry = { callback: callback as EventCallback, once: false };
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(entry);
    return () => this.off(event, callback as EventCallback);
  }

  once<K extends keyof Events & string>(event: K, callback: EventCallback<Events[K]>): () => void {
    const entry: EventEntry = { callback: callback as EventCallback, once: true };
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(entry);
    return () => this.off(event, callback as EventCallback);
  }

  off(event: keyof Events & string, callback: EventCallback): void {
    const entries = this.listeners.get(event);
    if (!entries) return;
    const idx = entries.findIndex((e) => e.callback === callback);
    if (idx !== -1) entries.splice(idx, 1);
  }

  async emit<K extends keyof Events & string>(event: K, payload: Events[K]): Promise<void> {
    const entries = this.listeners.get(event);
    if (!entries || entries.length === 0) return;

    const toRemove: EventEntry[] = [];
    for (const entry of entries) {
      try {
        await entry.callback(payload);
      } catch (err) {
        console.error(`[EventBus] Error in listener for "${event}":`, err);
      }
      if (entry.once) toRemove.push(entry);
    }

    for (const entry of toRemove) {
      const idx = entries.indexOf(entry);
      if (idx !== -1) entries.splice(idx, 1);
    }
  }

  handleRequest<KReq extends keyof Events & string, KRes extends keyof Events & string>(
    event: KReq,
    handler: (payload: Events[KReq]) => Promise<Events[KRes]>,
  ): () => void {
    const erased: (payload: unknown) => Promise<unknown> = (payload: unknown) =>
      handler(payload as Events[KReq]);
    this.requestHandlers.set(event, erased);
    return () => this.requestHandlers.delete(event);
  }

  async request<KReq extends keyof Events & string, KRes extends keyof Events & string>(
    event: KReq,
    payload: Events[KReq],
  ): Promise<Events[KRes]> {
    const handler = this.requestHandlers.get(event);
    if (!handler) {
      throw new Error(`[EventBus] No handler registered for request "${event}"`);
    }
    return (await handler(payload)) as Events[KRes];
  }

  listenerCount(event: string): number {
    return this.listeners.get(event as keyof Events & string)?.length ?? 0;
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.listeners.delete(event as keyof Events & string);
      this.requestHandlers.delete(event as keyof Events & string);
    } else {
      this.listeners.clear();
      this.requestHandlers.clear();
    }
  }
}
