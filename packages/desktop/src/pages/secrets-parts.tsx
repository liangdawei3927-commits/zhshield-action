import type { ReactNode } from 'react';
import type { SecretReportData } from '../types/electron';
import { useT } from '../i18n';
import { PageShell } from '../components/business/PageShell';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { SECRET_SEVERITY_CONFIG, SECRET_STATUS_CONFIG, SECRET_TYPE_LABEL } from './secrets-logic';

export function SecretsIllustration() {
  return (
    <svg width="150" height="150" viewBox="0 0 150 150" fill="none">
      <circle cx="75" cy="75" r="65" fill="rgb(var(--zh-brand) / 0.05)" />
      <circle cx="75" cy="75" r="55" fill="rgb(var(--zh-brand) / 0.03)" />
      <path
        d="M33 50V40a7 7 0 0 1 7-7h10"
        stroke="rgb(var(--zh-brand-lighter))"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M117 50V40a7 7 0 0 0-7-7h-10"
        stroke="rgb(var(--zh-brand-lighter))"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M33 100v10a7 7 0 0 0 7 7h10"
        stroke="rgb(var(--zh-brand-lighter))"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M117 100v10a7 7 0 0 1-7 7h-10"
        stroke="rgb(var(--zh-brand-lighter))"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="62" cy="74" r="16" stroke="rgb(var(--zh-brand))" strokeWidth="5" />
      <path d="M75 74h28" stroke="rgb(var(--zh-brand))" strokeWidth="5" strokeLinecap="round" />
      <path
        d="M97 74l6 6M97 74l6-6M85 74l6 6"
        stroke="rgb(var(--zh-brand))"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle cx="112" cy="112" r="2" fill="rgb(var(--zh-danger))" />
      <path d="M112 100v-6" stroke="rgb(var(--zh-danger))" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

function SecretsKeyIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="rgb(var(--zh-brand))"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M11 12L21 2" />
      <path d="M15.5 7.5l3 3L22 7l-3-3" />
    </svg>
  );
}

function SummaryChip({
  label,
  value,
  color,
  bg,
}: {
  label: string;
  value: number;
  color: string;
  bg: string;
}) {
  return (
    <span
      className="px-2.5 py-1 rounded-full text-xs font-medium"
      style={{ color, background: bg }}
    >
      {label} {value}
    </span>
  );
}

export function SecretsHeader({
  report,
  loading,
  onRescan,
}: {
  report: SecretReportData;
  loading: boolean;
  onRescan: () => void;
}) {
  const t = useT();
  return (
    <div className="mb-8">
      <div className="flex items-center gap-4">
        <Bounce className="w-12 h-12 rounded-xl bg-brand-50 flex items-center justify-center">
          <SecretsKeyIcon />
        </Bounce>
        <div>
          <h1 className="text-2xl font-bold text-zh-ink mb-1">{t('page.secrets.done')}</h1>
          <p className="text-sm text-zh-muted">
            {t('page.secrets.summary', {
              total: report.summary.total,
              critical: report.summary.critical,
              active: report.summary.active,
            })}
          </p>
        </div>
        <PrimaryButton
          className="ml-auto"
          onClick={onRescan}
          loading={loading}
          loadingLabel={t('page.secrets.checking')}
        >
          {t('page.secrets.rescan')}
        </PrimaryButton>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <SummaryChip
          label={t('page.secrets.summaryChip.total')}
          value={report.summary.total}
          color="rgb(var(--zh-ink-2))"
          bg="rgb(var(--zh-bg-secondary))"
        />
        <SummaryChip
          label={t('page.secrets.summaryChip.critical')}
          value={report.summary.critical}
          color="rgb(var(--zh-danger))"
          bg="rgb(var(--zh-danger) / 0.1)"
        />
        <SummaryChip
          label={t('page.secrets.summaryChip.active')}
          value={report.summary.active}
          color="rgb(var(--zh-warning))"
          bg="rgb(var(--zh-warning) / 0.12)"
        />
        <SummaryChip
          label={t('page.secrets.summaryChip.historyOnly')}
          value={report.summary.historyFound}
          color="rgb(var(--zh-info))"
          bg="rgb(var(--zh-info) / 0.1)"
        />
      </div>
      <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-zh-panel">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgb(var(--zh-muted))"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
        <span className="text-xs text-zh-muted">{t('page.secrets.remoteNote')}</span>
      </div>
      {report.error && (
        <div className="mt-4 flex items-center gap-3 px-4 py-3 rounded-xl bg-red-50 border border-red-100">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="rgb(var(--zh-danger))"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
          <div>
            <div className="text-sm font-medium text-red-700">{t('page.secrets.errorTitle')}</div>
            <div className="text-xs text-red-500 mt-0.5">{report.error}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionTitle({
  icon,
  label,
  right,
}: {
  icon: ReactNode;
  label: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <span className="w-6 h-6 rounded-md bg-brand-50 text-brand-700 flex items-center justify-center shrink-0">
        {icon}
      </span>
      <span className="text-sm font-semibold text-zh-ink-2">{label}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}

function ActionButton({
  label,
  title,
  primary,
  onClick,
}: {
  label: string;
  title: string;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`px-2.5 py-1 rounded-lg text-xs font-medium border-none cursor-pointer transition-colors ${
        primary
          ? 'bg-brand-50 text-brand-700 hover:bg-brand-100'
          : 'bg-zh-panel text-zh-ink-2 hover:bg-zh-line'
      }`}
    >
      {label}
    </button>
  );
}

function SecretsFindingItem({
  finding,
  onMarkRotating,
  onVerifyRotated,
  onDismiss,
}: {
  finding: SecretReportData['findings'][number];
  onMarkRotating: (secretId: string) => void;
  onVerifyRotated: (secretId: string) => void;
  onDismiss: (secretId: string) => void;
}) {
  const t = useT();
  const sevCfg = SECRET_SEVERITY_CONFIG[finding.severity] ?? SECRET_SEVERITY_CONFIG.low;
  const statusCfg = SECRET_STATUS_CONFIG[finding.status] ?? SECRET_STATUS_CONFIG.active;
  const typeKey = SECRET_TYPE_LABEL[finding.type] ?? 'page.secrets.type.genericApiKey';
  const commit = finding.location.commit ? finding.location.commit.slice(0, 7) : '';
  return (
    <ResultCard>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-sm font-semibold text-zh-ink break-all">
          {finding.displayValue}
        </span>
        <span
          className="px-2 py-0.5 rounded text-xs font-medium shrink-0"
          style={{ background: sevCfg.bg, color: sevCfg.color }}
        >
          {t(sevCfg.labelKey)}
        </span>
        <span className="px-2 py-0.5 rounded text-xs font-medium bg-zh-panel text-zh-ink-2 shrink-0">
          {t(typeKey)}
        </span>
        <span className="ml-auto text-[11px] shrink-0" style={{ color: statusCfg.color }}>
          {t(statusCfg.labelKey)}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-3 flex-wrap">
        <span className="text-xs text-zh-muted font-mono">
          {finding.location.file}:{finding.location.line}
        </span>
        {commit && <span className="text-xs text-zh-muted font-mono">{commit}</span>}
        {finding.stillReferenced ? (
          <span
            className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-50"
            style={{ color: 'rgb(var(--zh-success-700))' }}
          >
            {t('page.secrets.badge.active')}
          </span>
        ) : (
          <span
            className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-zh-panel"
            style={{ color: 'rgb(var(--zh-muted))' }}
          >
            {t('page.secrets.badge.historyOnly')}
          </span>
        )}
        {finding.pushedToRemote && (
          <span
            className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-zh-panel"
            style={{ color: 'rgb(var(--zh-info))' }}
          >
            {t('page.secrets.badge.pushedToRemote')}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {finding.status === 'active' && (
            <ActionButton
              primary
              label={t('page.secrets.action.markRotating')}
              title={t('page.secrets.action.markRotatingConfirm')}
              onClick={() => onMarkRotating(finding.secretId)}
            />
          )}
          {finding.status === 'rotating' && (
            <>
              <ActionButton
                primary
                label={t('page.secrets.action.verifyRotated')}
                title={t('page.secrets.action.verifyRotatedConfirm')}
                onClick={() => onVerifyRotated(finding.secretId)}
              />
              <ActionButton
                label={t('page.secrets.action.dismiss')}
                title={t('page.secrets.action.dismissConfirm')}
                onClick={() => onDismiss(finding.secretId)}
              />
            </>
          )}
          {finding.status === 'rotated' && (
            <ActionButton
              label={t('page.secrets.action.dismiss')}
              title={t('page.secrets.action.dismissConfirm')}
              onClick={() => onDismiss(finding.secretId)}
            />
          )}
        </span>
      </div>
    </ResultCard>
  );
}

export function SecretsListCard({
  findings,
  onMarkRotating,
  onVerifyRotated,
  onDismiss,
}: {
  findings: SecretReportData['findings'];
  onMarkRotating: (secretId: string) => void;
  onVerifyRotated: (secretId: string) => void;
  onDismiss: (secretId: string) => void;
}) {
  const t = useT();
  return (
    <ResultCard variant="score">
      <SectionTitle
        icon={
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 12a9 9 0 1 1-3.6-7.2" />
            <path d="M21 3v6h-6" />
          </svg>
        }
        label={t('page.secrets.list.title')}
        right={<span className="text-xs text-zh-muted">{t('page.secrets.list.hint')}</span>}
      />
      {findings.length === 0 ? (
        <div className="rounded-xl flex flex-col items-center justify-center py-12 gap-2 bg-zh-panel border border-dashed border-zh-line">
          <span className="text-2xl">🟢</span>
          <span className="text-sm font-medium text-green-700">{t('page.secrets.list.empty')}</span>
        </div>
      ) : (
        <div className="space-y-3">
          {findings.map((finding) => (
            <SecretsFindingItem
              key={finding.secretId}
              finding={finding}
              onMarkRotating={onMarkRotating}
              onVerifyRotated={onVerifyRotated}
              onDismiss={onDismiss}
            />
          ))}
        </div>
      )}
    </ResultCard>
  );
}

export function SecretsEmptyState({ loading, onScan }: { loading: boolean; onScan: () => void }) {
  const t = useT();
  return (
    <PageShell
      illustration={<SecretsIllustration />}
      title={t('page.secrets.empty.title')}
      subtitle={t('page.secrets.empty.subtitle')}
      featureList={[
        {
          icon: (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
          ),
          title: t('page.secrets.feature.scan.title'),
          desc: t('page.secrets.feature.scan.desc'),
        },
        {
          icon: (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M8 13h8M8 17h5" />
            </svg>
          ),
          title: t('page.secrets.feature.locate.title'),
          desc: t('page.secrets.feature.locate.desc'),
        },
        {
          icon: (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="7.5" cy="15.5" r="4.5" />
              <path d="M11 12L21 2" />
              <path d="M15.5 7.5l3 3L22 7l-3-3" />
            </svg>
          ),
          title: t('page.secrets.feature.rotate.title'),
          desc: t('page.secrets.feature.rotate.desc'),
        },
      ]}
      buttonText={t('page.secrets.empty.start')}
      onAction={onScan}
      loading={loading}
      progressLabel={t('page.secrets.checking')}
    />
  );
}
