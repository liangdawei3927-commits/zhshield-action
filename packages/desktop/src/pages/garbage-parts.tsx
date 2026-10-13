import type {
  GarbageScanReportData,
  GarbageCleanResultData,
  GarbageRestoreResultData,
} from '../types/electron';
import { useT } from '../i18n';
import { formatSize } from './garbage-list-parts';

export {
  GARBAGE_TYPE_LABEL,
  formatSize,
  GarbageList,
  GarbageActionBar,
} from './garbage-list-parts';

/** 未执行检测项提示：工具不可用 / 规则空跑时显式告知，禁止把「没查」当「没垃圾」 */
export function GarbageSkippedNotice({ report }: { report: GarbageScanReportData }) {
  const t = useT();
  const skipped = report.checks.filter((c) => !c.ran);
  if (skipped.length === 0) return null;
  return (
    <div className="mt-4 rounded-xl px-5 py-4 bg-warning-50 border border-warning-100">
      <div className="text-sm font-medium text-warning-700">
        {t('page.garbage.skippedNotice', { count: skipped.length })}
      </div>
      <ul className="mt-2 space-y-1">
        {skipped.map((c) => (
          <li key={c.ruleId} className="text-xs text-warning-600">
            {c.name}
            {c.reason ? ` · ${c.reason}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CleanResultBanner({
  result,
  onRestore,
  restoring,
}: {
  result: GarbageCleanResultData;
  onRestore: () => void;
  restoring: boolean;
}) {
  const t = useT();
  const cleaned = result.cleaned.length;
  if (cleaned === 0 && result.failed.length === 0) return null;
  return (
    <div className="rounded-xl px-5 py-4 bg-success-50 border border-success-100 mb-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-success-700">
          {t('page.garbage.cleaned', { count: cleaned, size: formatSize(result.freedBytes) })}
        </span>
        {result.batchId && (
          <button
            onClick={onRestore}
            disabled={restoring}
            className="ml-auto h-9 px-4 rounded-full bg-zh-card text-success-700 text-sm font-medium border border-success-200 hover:bg-success-100 transition-colors cursor-pointer disabled:opacity-50"
          >
            {restoring ? t('page.garbage.restoring') : t('page.garbage.restore')}
          </button>
        )}
      </div>
      {result.failed.length > 0 && (
        <div className="mt-2 text-xs text-warning-600">
          {t('page.garbage.cleanFailedCount', { count: result.failed.length })}
        </div>
      )}
    </div>
  );
}

export function RestoreBanner({ result }: { result: GarbageRestoreResultData }) {
  const t = useT();
  return (
    <div className="rounded-xl px-5 py-4 bg-info-50 border border-info-100 mb-4">
      <div className="text-sm font-medium text-info-700">
        {t('page.garbage.restored', {
          count: result.restored,
          size: formatSize(result.restoredBytes),
        })}
      </div>
      {result.failed.length > 0 && (
        <div className="mt-2 text-xs text-warning-600">
          {t('page.garbage.restoreFailedCount', { count: result.failed.length })}
        </div>
      )}
    </div>
  );
}
