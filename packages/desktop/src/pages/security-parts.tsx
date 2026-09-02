import type { SecurityScanReportData } from '../types/electron';
import { useT } from '../i18n';
import { SEVERITY_CONFIG, MALWARE_TYPE_LABEL, type SecurityIssue } from './security-logic';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyToAiButton } from '../components/ui/CopyToAiButton';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';

export { SecurityScoreCard } from './security-score-parts';

/** 红色盾牌 SVG（线性风格） */
export function RedShield() {
  return (
    <svg width="150" height="150" viewBox="0 0 150 150" fill="none">
      <circle cx="75" cy="75" r="65" fill="rgb(var(--zh-danger) / 0.05)" />
      <circle cx="75" cy="75" r="55" fill="rgb(var(--zh-danger) / 0.03)" />
      {/* 盾牌 */}
      <path
        d="M75 25L35 50v25c0 20.83 15.2 40.17 40 44.64C99.8 115.17 115 95.83 115 75V50L75 25z"
        fill="rgb(var(--zh-danger) / 0.08)"
        stroke="rgb(var(--zh-danger))"
        strokeWidth="2.5"
      />
      {/* 勾选标志 */}
      <path
        d="M58 75l12 12 22-22"
        stroke="rgb(var(--zh-danger))"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export function SecurityHeader({
  report,
  loading,
  progressLabel,
  onRescan,
}: {
  report: SecurityScanReportData;
  loading: boolean;
  progressLabel?: string;
  onRescan: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-4 mb-8">
      <Bounce className="w-12 h-12 rounded-xl bg-danger-50 flex items-center justify-center">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgb(var(--zh-danger))"
          strokeWidth="1.8"
        >
          <path d="M12 2L3 7v6c0 5.25 3.83 10.13 9 11.25C17.17 23.13 21 18.25 21 13V7l-9-5z" />
          <path d="M9 13l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Bounce>
      <div>
        <h1 className="text-2xl font-bold text-zh-ink mb-1">{t('page.security.done')}</h1>
        <p className="text-sm text-zh-muted">
          {t('page.security.summary', {
            vulns: report.summary.total,
            malware: report.summary.malwareTotal,
            garbage: report.summary.garbageTotal,
          })}
        </p>
      </div>
      <PrimaryButton
        className="ml-auto"
        onClick={onRescan}
        loading={loading}
        loadingLabel={progressLabel || t('page.security.checking')}
      >
        {t('page.security.rescan')}
      </PrimaryButton>
    </div>
  );
}

function FindingCard({
  finding,
  onCopyToAi,
}: {
  finding: SecurityScanReportData['findings'][number];
  onCopyToAi: (issue: SecurityIssue) => void;
}) {
  const t = useT();
  const cfg = SEVERITY_CONFIG[finding.severity] ?? SEVERITY_CONFIG.low;
  return (
    <ResultCard>
      <div className="flex items-center gap-3">
        <span
          className="px-2 py-0.5 rounded text-xs font-medium"
          style={{ background: cfg.bg, color: cfg.color }}
        >
          {t(cfg.labelKey)}
        </span>
        <span className="text-sm font-medium text-zh-ink-2">{finding.title}</span>
        <CopyToAiButton className="ml-auto" onClick={() => onCopyToAi(finding)} />
      </div>
      <div className="mt-2 text-xs text-zh-muted">
        {finding.file}
        {finding.line != null ? `:${finding.line}` : ''}
      </div>
      <div className="mt-1 text-xs text-zh-muted">{finding.description}</div>
      {finding.recommendation && (
        <div className="mt-1 text-xs text-info-500">
          {t('page.security.recommendation', { recommendation: finding.recommendation })}
        </div>
      )}
    </ResultCard>
  );
}

function MalwareCard({
  item,
  onCopyToAi,
}: {
  item: SecurityScanReportData['malware'][number];
  onCopyToAi: (issue: SecurityIssue) => void;
}) {
  const t = useT();
  const cfg = SEVERITY_CONFIG[item.severity] ?? SEVERITY_CONFIG.low;
  return (
    <ResultCard>
      <div className="flex items-center gap-3">
        <span
          className="px-2 py-0.5 rounded text-xs font-medium"
          style={{ background: cfg.bg, color: cfg.color }}
        >
          {t(cfg.labelKey)}
        </span>
        <span className="px-2 py-0.5 rounded text-xs font-medium bg-zh-panel text-zh-ink-2">
          {t(MALWARE_TYPE_LABEL[item.type] ?? item.type)}
        </span>
        <span className="text-sm font-medium text-zh-ink-2">{item.title}</span>
        <CopyToAiButton className="ml-auto" onClick={() => onCopyToAi(item)} />
      </div>
      <div className="mt-2 text-xs text-zh-muted">
        {item.file}:{item.line}
      </div>
      <div className="mt-1 text-xs text-zh-muted">{item.description}</div>
      {item.evidence && (
        <div className="mt-2 px-3 py-1.5 rounded bg-danger-50 text-[11px] font-mono text-danger-700 break-all">
          {item.evidence}
        </div>
      )}
    </ResultCard>
  );
}

export function FindingsPanel({
  findings,
  onCopyToAi,
  onCopyAll,
}: {
  findings: SecurityScanReportData['findings'];
  onCopyToAi: (issue: SecurityIssue) => void;
  onCopyAll: (issues: SecurityIssue[]) => void;
}) {
  const t = useT();
  return (
    <div>
      {findings.length > 0 && (
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-zh-muted">
            {t('page.security.copyAllPrompt', { count: findings.length })}
          </span>
          <CopyAllToAiButton onClick={() => onCopyAll(findings)} />
        </div>
      )}
      <div className="space-y-3">
        {findings.map((finding) => (
          <FindingCard key={finding.id} finding={finding} onCopyToAi={onCopyToAi} />
        ))}
        {findings.length === 0 && (
          <div className="rounded-xl flex flex-col items-center justify-center py-16 gap-2 bg-zh-panel border border-dashed border-zh-line">
            <span className="text-2xl">✅</span>
            <span className="text-sm font-medium text-success-700">
              {t('page.security.noFindings')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function MalwarePanel({
  items,
  onCopyToAi,
  onCopyAll,
}: {
  items: SecurityScanReportData['malware'];
  onCopyToAi: (issue: SecurityIssue) => void;
  onCopyAll: (issues: SecurityIssue[]) => void;
}) {
  const t = useT();
  return (
    <div>
      {items.length > 0 && (
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-zh-muted">
            {t('page.security.copyAllPrompt', { count: items.length })}
          </span>
          <CopyAllToAiButton onClick={() => onCopyAll(items)} />
        </div>
      )}
      <div className="space-y-3">
        {items.map((item) => (
          <MalwareCard key={item.id} item={item} onCopyToAi={onCopyToAi} />
        ))}
        {items.length === 0 && (
          <div className="rounded-xl flex flex-col items-center justify-center py-16 gap-2 bg-zh-panel border border-dashed border-zh-line">
            <span className="text-2xl">🛡️</span>
            <span className="text-sm font-medium text-success-700">
              {t('page.security.noMalware')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
