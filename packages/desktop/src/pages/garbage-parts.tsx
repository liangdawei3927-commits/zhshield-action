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

/**
 * 子项目提示：目标本身没有可检测的代码，但旁边恰好有一个可检测的子项目。
 *
 * 只提示、不自动改判（2026-11-09 事故：扫描根被静默换成内层仓库，页面回落到旧报告显示
 * 100 分）。用户点按钮才换扫描对象，且换后页面明确标注「本次扫描对象」。
 */
export function NestedProjectNotice({
  suggestion,
  active,
  scanning,
  onSwitch,
}: {
  suggestion: { path: string; name: string };
  /** 当前报告是否就是这个子项目扫出来的 */
  active: boolean;
  scanning: boolean;
  onSwitch: (target: { path: string; name: string } | null) => void;
}) {
  const t = useT();
  return (
    <div className="mt-4 rounded-xl px-5 py-4 bg-info-50 border border-info-100 flex items-center gap-3">
      <div className="text-sm font-medium text-info-700">
        {active
          ? t('page.garbage.nestedProject.active', { name: suggestion.name })
          : t('page.garbage.nestedProject.hint', { name: suggestion.name })}
      </div>
      <button
        onClick={() => onSwitch(active ? null : suggestion)}
        disabled={scanning}
        className="ml-auto h-9 px-4 rounded-full bg-zh-card text-info-700 text-sm font-medium border border-info-200 hover:bg-info-100 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
      >
        {active ? t('page.garbage.nestedProject.back') : t('page.garbage.nestedProject.switch')}
      </button>
    </div>
  );
}

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
