import type { SecurityScanReportData } from '../types/electron';
import { useT } from '../i18n';
import { ResultCard } from '../components/ui/ResultCard';

/**
 * 安全中心扫描结果统计卡。
 *
 * 历史说明：此卡曾用 report.securityScore（扫描引擎自带分）画分值圈，
 * 与 @zh/scoring 的 security 维扣分口径不一致（同名双实现）。09-19 统一：
 * 分数展示交给 DomainScoreCard（只读不算，单一来源），本卡只陈列本次
 * 扫描的严重度分布，不产分。
 */
export function SecurityScoreCard({ report }: { report: SecurityScanReportData }) {
  const t = useT();
  return (
    <ResultCard variant="score" className="flex items-center gap-6 mb-6">
      <div>
        <div className="text-sm font-semibold text-zh-ink-2">{t('page.security.statsTitle')}</div>
        <div className="flex gap-3 mt-2">
          <span className="text-xs flex items-center gap-1 text-success-700">
            <span className="w-1.5 h-1.5 rounded-full bg-success-700" />
            {t('page.security.lowRisk', { count: report.summary.low })}
          </span>
          <span className="text-xs flex items-center gap-1 text-warning-500">
            <span className="w-1.5 h-1.5 rounded-full bg-warning-500" />
            {t('severity.medium')} {report.summary.medium}
          </span>
          <span className="text-xs flex items-center gap-1 text-danger-500">
            <span className="w-1.5 h-1.5 rounded-full bg-danger-500" />
            {t('severity.high')} {report.summary.high}
          </span>
          <span
            className="text-xs flex items-center gap-1"
            style={{ color: 'rgb(var(--zh-danger-dark))' }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: 'rgb(var(--zh-danger-dark))' }}
            />
            {t('severity.critical')} {report.summary.critical}
          </span>
          <span className="text-xs flex items-center gap-1 text-danger-600">
            <span className="w-1.5 h-1.5 rounded-full bg-danger-600" />
            {t('page.security.malwareCount', { count: report.summary.malwareTotal })}
          </span>
        </div>
      </div>
    </ResultCard>
  );
}
