import type { SecretReportData } from '../types/electron';
import { useT } from '../i18n';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyToAiButton } from '../components/ui/CopyToAiButton';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';
import { SectionTitle } from '../components/ui/SectionTitle';
import { SectionIcon, AlertCircleIcon } from '../components/ui/Icons';
import { SECRET_SEVERITY_CONFIG, SECRET_STATUS_CONFIG, SECRET_TYPE_LABEL } from './secrets-logic';

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
  onCopyToAi,
}: {
  finding: SecretReportData['findings'][number];
  onMarkRotating: (secretId: string) => void;
  onVerifyRotated: (secretId: string) => void;
  onDismiss: (secretId: string) => void;
  onCopyToAi: (finding: SecretReportData['findings'][number]) => void;
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
            className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-success-50"
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
          <CopyToAiButton onClick={() => onCopyToAi(finding)} />
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
  error,
  onMarkRotating,
  onVerifyRotated,
  onDismiss,
  onCopyToAi,
  onCopyAll,
}: {
  findings: SecretReportData['findings'];
  error?: string | null;
  onMarkRotating: (secretId: string) => void;
  onVerifyRotated: (secretId: string) => void;
  onDismiss: (secretId: string) => void;
  onCopyToAi: (finding: SecretReportData['findings'][number]) => void;
  onCopyAll: (findings: SecretReportData['findings']) => void;
}) {
  const t = useT();
  return (
    <ResultCard variant="score">
      <SectionTitle
        icon={
          <SectionIcon>
            <path d="M21 12a9 9 0 1 1-3.6-7.2" />
            <path d="M21 3v6h-6" />
          </SectionIcon>
        }
        label={t('page.secrets.list.title')}
        right={<span className="text-xs text-zh-muted">{t('page.secrets.list.hint')}</span>}
      />
      {/* 扫描失败必须显式呈现：engine 不可用时 runSecrets 返回空 findings + error，
          若只渲染 findings，用户看到的是「无密钥」的绿色空态，会误判为扫描通过。 */}
      {error && (
        <div className="mb-4 flex items-center gap-3 px-4 py-3 rounded-xl bg-danger-50 border border-danger-100">
          <AlertCircleIcon />
          <div>
            <div className="text-sm font-medium text-danger-700">
              {t('page.secrets.errorTitle')}
            </div>
            <div className="text-xs text-danger-500 mt-0.5">{error}</div>
          </div>
        </div>
      )}
      {findings.length === 0 ? (
        <div className="rounded-xl flex flex-col items-center justify-center py-12 gap-2 bg-zh-panel border border-dashed border-zh-line">
          <span className="text-2xl">🟢</span>
          <span className="text-sm font-medium text-success-700">
            {t('page.secrets.list.empty')}
          </span>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-zh-muted">
              {t('page.secrets.copyAllPrompt', { count: findings.length })}
            </span>
            <CopyAllToAiButton onClick={() => onCopyAll(findings)} />
          </div>
          <div className="space-y-3">
            {findings.map((finding) => (
              <SecretsFindingItem
                key={finding.secretId}
                finding={finding}
                onMarkRotating={onMarkRotating}
                onVerifyRotated={onVerifyRotated}
                onDismiss={onDismiss}
                onCopyToAi={onCopyToAi}
              />
            ))}
          </div>
        </>
      )}
    </ResultCard>
  );
}
