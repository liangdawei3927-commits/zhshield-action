import type { SecurityScanReportData } from '../types/electron';
import type { Translate } from './security-tab-bar';

/**
 * 本次检查失败时的显形提示（旧结果不能冒充本次）。
 *
 * 正常 / 上次保存的检查时间统一放在分类标签行右侧，不再单独占一行；
 * 「上次保存」由标题「上次检查结果」表达。
 */
export function SecurityResultMeta({
  report,
  scanError,
  t,
}: {
  report: SecurityScanReportData;
  scanError?: string | null;
  t: Translate;
}) {
  if (!scanError) return null;
  const time = report.metadata?.timestamp
    ? new Date(report.metadata.timestamp).toLocaleString()
    : t('page.security.result.unknownTime', { defaultValue: '时间未知' });

  return (
    <div className="mb-4 px-4 py-3 rounded-xl bg-danger-50 border border-danger-100">
      <div className="text-sm font-medium text-danger-700">
        {t('page.security.result.failedTitle', {
          defaultValue: '本次检查未完成：{{error}}',
          error: scanError,
        })}
      </div>
      <div className="text-xs text-danger-500 mt-0.5">
        {t('page.security.result.failedDetail', {
          defaultValue: '下方显示的是 {{time}} 保存的旧结果，不代表本次扫描；修复后请重新检查。',
          time,
        })}
      </div>
    </div>
  );
}
