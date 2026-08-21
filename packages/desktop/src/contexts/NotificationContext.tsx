import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { NotificationService } from '@zh/kernel';
import type { AppNotification } from '@zh/kernel';

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

const PREFS_KEY = 'zhshield.notificationPrefs';

interface NotificationPreferences {
  readonly enabled: boolean;
}

const DEFAULT_PREFS: NotificationPreferences = { enabled: true };

function readPrefs(): NotificationPreferences {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (raw === null) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<NotificationPreferences>;
    return { enabled: parsed.enabled ?? DEFAULT_PREFS.enabled };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writePrefs(prefs: NotificationPreferences): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage unavailable — silent fallback
  }
}

// ---------------------------------------------------------------------------
// Context value
// ---------------------------------------------------------------------------

export interface NotificationContextValue {
  readonly notify: (notification: AppNotification) => void;
  readonly preferences: NotificationPreferences;
  readonly setPreferences: (prefs: NotificationPreferences) => void;
}

export const NotificationContext = createContext<NotificationContextValue | null>(null);

// ---------------------------------------------------------------------------
// Browser permission helper (globalThis, not window)
// ---------------------------------------------------------------------------

type BrowserNotificationCtor = new (title: string, options?: { body?: string }) => { close(): void };
type BrowserNotificationStatic = BrowserNotificationCtor & {
  permission: string;
  requestPermission(): Promise<string>;
};

function getBrowserNotification(): BrowserNotificationStatic | undefined {
  if (typeof globalThis === 'undefined' || !('Notification' in globalThis)) return undefined;
  return (globalThis as Record<string, unknown>).Notification as BrowserNotificationStatic;
}

function requestBrowserPermission(): void {
  const BrowserNotification = getBrowserNotification();
  if (BrowserNotification && BrowserNotification.permission === 'default') {
    void BrowserNotification.requestPermission();
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const serviceRef = useRef<NotificationService>(null!);
  if (serviceRef.current === null) {
    serviceRef.current = new NotificationService({ browserNotification: true });
  }
  const service = serviceRef.current;

  const [preferences, setPreferencesState] = useState<NotificationPreferences>(readPrefs);

  // Request browser notification permission once on mount
  useEffect(() => {
    requestBrowserPermission();
  }, []);

  // Persist preferences on change
  const setPreferences = useCallback((prefs: NotificationPreferences) => {
    setPreferencesState(prefs);
    writePrefs(prefs);
  }, []);

  // Core notify: route to service helper based on type, gated by preference
  const notify = useCallback(
    (notification: AppNotification) => {
      if (!preferences.enabled) return;

      switch (notification.type) {
        case 'info':
          service.info(notification.title, notification.message);
          break;
        case 'success':
          service.success(notification.title, notification.message);
          break;
        case 'warning':
          service.warning(notification.title, notification.message);
          break;
        case 'error':
          service.error(notification.title, notification.message);
          break;
        default:
          service.info(notification.title, notification.message);
          break;
      }
    },
    [service, preferences.enabled],
  );

  const value = useMemo<NotificationContextValue>(
    () => ({ notify, preferences, setPreferences }),
    [notify, preferences, setPreferences],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

// ---------------------------------------------------------------------------
// Consumer hook
// ---------------------------------------------------------------------------

export function useNotification(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (ctx === null) throw new Error('useNotification must be used within <NotificationProvider>');
  return ctx;
}
