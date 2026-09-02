import { createContext, useCallback, useContext, useState } from 'react';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
}

export interface ToastContextValue {
  toasts: ToastItem[];
  toast: (message: string, variant?: ToastVariant) => void;
  dismiss: (id: string) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

let toastId = 0;

export function useToastStore() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, variant: ToastVariant = 'info') => {
      const id = `toast-${++toastId}`;
      setToasts((prev) => [...prev, { id, message, variant }]);
      setTimeout(dismiss, 3500, id);
    },
    [dismiss],
  );

  return { toasts, toast, dismiss };
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

export const variantStyles: Record<ToastVariant, { bg: string; border: string; icon: string }> = {
  success: { bg: 'bg-success-50', border: 'border-success-200', icon: '✓' },
  error: { bg: 'bg-danger-50', border: 'border-danger-200', icon: '✗' },
  warning: { bg: 'bg-warning-50', border: 'border-warning-200', icon: '!' },
  info: { bg: 'bg-info-50', border: 'border-info-200', icon: 'i' },
};
