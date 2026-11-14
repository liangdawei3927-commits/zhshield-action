import type { AppNotification, NotificationListener, NotificationStore } from './types';

/**
 * 浏览器 Notification API 的最小类型面（构造器 + 静态成员）。
 *
 * 主进程通知服务与渲染进程（`desktop/src/contexts/NotificationContext.tsx`）
 * 各自需要同一份 DOM 全局类型；渲染侧曾照抄一份（2026-11-15 核实为逐字相同）。
 * 类型漂移不会报错，只会让两侧对 `permission` / `requestPermission` 的理解悄悄分叉，
 * 故统一由本模块导出。
 */
export type BrowserNotificationCtor = new (
  title: string,
  options?: { body?: string },
) => { close(): void };
export type BrowserNotificationStatic = BrowserNotificationCtor & {
  permission: string;
  requestPermission(): Promise<string>;
};

const hasGlobalNotification = (): boolean =>
  typeof globalThis !== 'undefined' && 'Notification' in globalThis;

const getBrowserNotification = (): BrowserNotificationStatic | undefined => {
  if (!hasGlobalNotification()) return undefined;
  return (globalThis as Record<string, unknown>).Notification as BrowserNotificationStatic;
};

export class NotificationService {
  private store: NotificationStore = { notifications: [], unreadCount: 0 };
  private listeners: Set<NotificationListener> = new Set();
  private useBrowserNotification: boolean;

  constructor(options?: { browserNotification?: boolean }) {
    this.useBrowserNotification = options?.browserNotification ?? true;
  }

  subscribe(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(notification: AppNotification): void {
    this.store.notifications.unshift(notification);
    this.store.unreadCount++;
    this.listeners.forEach((l) => l(notification));

    if (this.useBrowserNotification) {
      this.showBrowserNotification(notification);
    }
  }

  private showBrowserNotification(notification: AppNotification): void {
    const BrowserNotification = getBrowserNotification();
    if (!BrowserNotification) return;
    if (BrowserNotification.permission === 'granted') {
      new BrowserNotification(notification.title, {
        body: notification.message,
      });
    } else if (BrowserNotification.permission !== 'denied') {
      BrowserNotification.requestPermission();
    }
  }

  info(title: string, message: string): void {
    this.notify({
      id: crypto.randomUUID(),
      type: 'info',
      title,
      message,
      timestamp: new Date().toISOString(),
      read: false,
    });
  }

  success(title: string, message: string): void {
    this.notify({
      id: crypto.randomUUID(),
      type: 'success',
      title,
      message,
      timestamp: new Date().toISOString(),
      read: false,
    });
  }

  warning(title: string, message: string): void {
    this.notify({
      id: crypto.randomUUID(),
      type: 'warning',
      title,
      message,
      timestamp: new Date().toISOString(),
      read: false,
    });
  }

  error(title: string, message: string): void {
    this.notify({
      id: crypto.randomUUID(),
      type: 'error',
      title,
      message,
      timestamp: new Date().toISOString(),
      read: false,
    });
  }

  markAsRead(id: string): void {
    const notification = this.store.notifications.find((n) => n.id === id);
    if (notification && !notification.read) {
      notification.read = true;
      this.store.unreadCount = Math.max(0, this.store.unreadCount - 1);
    }
  }

  markAllAsRead(): void {
    this.store.notifications.forEach((n) => (n.read = true));
    this.store.unreadCount = 0;
  }

  clear(): void {
    this.store.notifications = [];
    this.store.unreadCount = 0;
  }

  getUnreadCount(): number {
    return this.store.unreadCount;
  }

  getNotifications(): AppNotification[] {
    return [...this.store.notifications];
  }
}

export const notificationService = new NotificationService();
