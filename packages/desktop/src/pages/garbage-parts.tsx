import type { SecurityScanReportData, GarbageCleanResultData, GarbageRestoreResultData } from '../types/electron';
import { useT } from '../i18n';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { formatSize } from './garbage-list-parts';

export { GARBAGE_TYPE_LABEL, formatSize, GarbageStats, GarbageList, GarbageActionBar } from './garbage-list-parts';

/** 绿色垃圾桶 SVG（线性风格） */
export function GarbageTrashIcon() {
  return (
    <svg width="150" height="150" viewBox="0 0 150 150" fill="none">
      <circle cx="75" cy="75" r="65" fill="rgb(var(--zh-success) / 0.05)" />
      <circle cx="75" cy="75" r="55" fill="rgb(var(--zh-success) / 0.03)" />
      <rect x="42" y="48" width="66" height="12" rx="4" fill="rgb(var(--zh-success) / 0.08)" stroke="rgb(var(--zh-success))" strokeWidth="2.5" />
      <path d="M52 60h46l-5 54a8 8 0 01-8 7H65a8 8 0 01-8-7l-5-54z" fill="rgb(var(--zh-success) / 0.08)" stroke="rgb(var(--zh-success))" strokeWidth="2.5" />
      <path d="M60 48v-8a15 15 0 0130 0v8" stroke="rgb(var(--zh-success))" strokeWidth="2.5" fill="none" />
      <path d="M64 72l3 32M75 72v32M86 72l-3 32" stroke="rgb(var(--zh-success))" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function GarbageHeader({ report, loading, progressLabel, onRescan }: { report: SecurityScanReportData; loading: boolean; progressLabel?: string; onRescan: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-4 mb-8">
      <Bounce className="w-12 h-12 rounded-xl bg-emerald-50 flex items-center justify-center">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--zh-success))" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
          <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
          <path d="M10 11v6M14 11v6" />
        </svg>
      </Bounce>
      <div>
        <h1 className="text-2xl font-bold text-zh-ink mb-1">{t('page.garbage.done')}</h1>
        <p className="text-sm text-zh-muted">{t('page.garbage.summary', { count: report.summary.garbageTotal, size: formatSize(report.summary.garbageSize) })}</p>
      </div>
      <PrimaryButton className="ml-auto" onClick={onRescan} loading={loading} loadingLabel={progressLabel || t('page.garbage.scanning')}>
        {t('page.garbage.rescan')}
      </PrimaryButton>
    </div>
  );
}

export function CleanResultBanner({ result, onRestore, restoring }: { result: GarbageCleanResultData; onRestore: () => void; restoring: boolean }) {
  const t = useT();
  const cleaned = result.cleaned.length;
  if (cleaned === 0 && result.failed.length === 0) return null;
  return (
    <div className="rounded-xl px-5 py-4 bg-emerald-50 border border-emerald-100 mb-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-emerald-700">
          {t('page.garbage.cleaned', { count: cleaned, size: formatSize(result.freedBytes) })}
        </span>
        {result.batchId && (
          <button
            onClick={onRestore}
            disabled={restoring}
            className="ml-auto h-9 px-4 rounded-full bg-zh-card text-emerald-700 text-sm font-medium border border-emerald-200 hover:bg-emerald-100 transition-colors cursor-pointer disabled:opacity-50"
          >
            {restoring ? t('page.garbage.restoring') : t('page.garbage.restore')}
          </button>
        )}
      </div>
      {result.failed.length > 0 && (
        <div className="mt-2 text-xs text-amber-600">{t('page.garbage.cleanFailedCount', { count: result.failed.length })}</div>
      )}
    </div>
  );
}

export function RestoreBanner({ result }: { result: GarbageRestoreResultData }) {
  const t = useT();
  return (
    <div className="rounded-xl px-5 py-4 bg-blue-50 border border-blue-100 mb-4">
      <div className="text-sm font-medium text-blue-700">
        {t('page.garbage.restored', { count: result.restored, size: formatSize(result.restoredBytes) })}
      </div>
      {result.failed.length > 0 && (
        <div className="mt-2 text-xs text-amber-600">{t('page.garbage.restoreFailedCount', { count: result.failed.length })}</div>
      )}
    </div>
  );
}
