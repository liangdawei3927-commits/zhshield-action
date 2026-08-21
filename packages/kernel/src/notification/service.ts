import type { AppNotification, NotificationListener, NotificationStore } from './types';

type BrowserNotificationCtor = new (title: string, options?: { body?: string }) => { close(): void };
type BrowserNotificationStatic = BrowserNotificationCtor & { permission: string; requestPermission(): Promise<string> };

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
      const BrowserNotification = getBrowserNotification();
      if (BrowserNotification) {
        if (BrowserNotification.permission === 'granted') {
          new BrowserNotification(notification.title, {
            body: notification.message,
          });
        } else if (BrowserNotification.permission !== 'denied') {
          BrowserNotification.requestPermission();
        }
      }
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