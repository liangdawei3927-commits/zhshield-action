import type { ReactNode } from 'react';
import { ToastContext, useToastStore, variantStyles } from './toast-logic';
import type { ToastItem } from './toast-logic';

export function ToastProvider({ children }: { children: ReactNode }) {
  const { toasts, toast, dismiss } = useToastStore();
  return (
    <ToastContext.Provider value={{ toasts, toast, dismiss }}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  return (
    <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map((t) => (
        <ToastCard key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const s = variantStyles[item.variant];
  return (
    <div
      className={`pointer-events-auto flex items-center gap-3 px-5 py-3 rounded-xl border shadow-lg ${s.bg} ${s.border} animate-[fadeInUp_0.25s_ease-out]`}
    >
      <span className="text-sm font-bold shrink-0">{s.icon}</span>
      <span className="text-sm text-zh-ink">{item.message}</span>
      <button
        onClick={() => onDismiss(item.id)}
        className="ml-2 text-zh-muted hover:text-zh-ink-2 text-sm leading-none border-none cursor-pointer"
      >
        ×
      </button>
    </div>
  );
}

export { useToast } from './toast-logic';
