import type { SecurityScanReportData } from '../types/electron';
import { useT } from '../i18n';
import { ResultCard } from '../components/ui/ResultCard';

export function SecurityScoreCard({ report }: { report: SecurityScanReportData }) {
  const t = useT();
  const score = report.securityScore;
  return (
    <ResultCard variant="score" className="flex items-center gap-6 mb-6">
      <div className="w-20 h-20 rounded-full flex items-center justify-center bg-green-50 border-[3px] border-green-700 shrink-0">
        <span className="text-2xl font-bold text-green-700">{score}</span>
      </div>
      <div>
        <div className="text-sm font-semibold text-zh-ink-2">{t('page.security.scoreLabel')}</div>
        <div className="flex gap-3 mt-2">
          <span className="text-xs flex items-center gap-1 text-green-700">
            <span className="w-1.5 h-1.5 rounded-full bg-green-700" />
            {t('page.security.lowRisk', { count: report.summary.low })}
          </span>
          <span className="text-xs flex items-center gap-1 text-amber-500">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            {t('severity.medium')} {report.summary.medium}
          </span>
          <span className="text-xs flex items-center gap-1 text-red-500">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
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
          <span className="text-xs flex items-center gap-1 text-red-600">
            <span className="w-1.5 h-1.5 rounded-full bg-red-600" />
            {t('page.security.malwareCount', { count: report.summary.malwareTotal })}
          </span>
        </div>
      </div>
    </ResultCard>
  );
}
