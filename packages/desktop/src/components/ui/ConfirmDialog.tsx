import { useEffect, useRef, type ReactNode } from 'react';
import { Bounce } from './Bounce';
import { useT } from '../../i18n';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string | ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      {/* dialog */}
      <div
        ref={dialogRef}
        className="relative bg-zh-card rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4 animate-[fadeInUp_0.2s_ease-out]"
      >
        <h3 className="text-base font-bold text-zh-ink mb-2">{title}</h3>
        <div className="text-sm text-zh-ink-2 mb-6">{message}</div>
        <div className="flex gap-3 justify-end">
          <Bounce
            as="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm font-medium text-zh-ink-2 bg-zh-panel hover:bg-zh-line border-none cursor-pointer transition-colors"
          >
            {cancelLabel ?? t('common.cancel')}
          </Bounce>
          <Bounce
            as="button"
            onClick={onConfirm}
            className={`px-4 py-2 rounded-lg text-sm font-medium text-white border-none cursor-pointer transition-colors ${
              variant === 'danger'
                ? 'bg-danger-500 hover:bg-danger-600'
                : 'bg-brand-600 hover:bg-brand-800'
            }`}
          >
            {confirmLabel ?? t('common.confirm')}
          </Bounce>
        </div>
      </div>
    </div>
  );
}
