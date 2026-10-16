import type {
  DependencyReportData,
  LockfileVerificationData,
  TyposquatFindingData,
  UpgradeAssessmentData,
} from '../types/electron';
import { useT } from '../i18n';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyToAiButton } from '../components/ui/CopyToAiButton';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';
import { SectionTitle } from '../components/ui/SectionTitle';
import { SectionIcon } from '../components/ui/Icons';
import { RISK_BADGE_CONFIG } from './dependency-logic';

/** 适配器失败提示条（对应各 error 字段；未失败时不渲染） */
export function AdapterErrorNote({ title, message }: { title: string; message?: string }) {
  if (!message) return null;
  return (
    <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-danger-50 border border-danger-100">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="rgb(var(--zh-danger))"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 shrink-0"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </svg>
      <div className="min-w-0">
        <div className="text-xs font-medium text-danger-700">{title}</div>
        <div className="text-[11px] text-danger-500 mt-0.5 break-all">{message}</div>
      </div>
    </div>
  );
}

/** 投毒检测空态：无可疑依赖 */
function TyposquatEmptyState() {
  const t = useT();
  return (
    <div className="rounded-xl flex flex-col items-center justify-center py-12 gap-2 bg-zh-panel border border-dashed border-zh-line">
      <span className="text-2xl">🛡️</span>
      <span className="text-sm font-medium text-success-700">
        {t('page.deps.typosquat.none')}
      </span>
    </div>
  );
}

/** 投毒检测单条：风险徽章 + 相似知名包 + 判定证据 */
function TyposquatFindingItem({
  finding,
  onCopyToAi,
}: {
  finding: TyposquatFindingData;
  onCopyToAi: (finding: TyposquatFindingData) => void;
}) {
  const t = useT();
  const cfg = RISK_BADGE_CONFIG[finding.risk] ?? RISK_BADGE_CONFIG.low;
  return (
    <div className="rounded-lg border border-zh-line p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-zh-ink-2">{finding.nodeId}</span>
        <span
          className="px-2 py-0.5 rounded text-[10px] font-medium"
          style={{ background: cfg.bg, color: cfg.color }}
        >
          {t(cfg.labelKey)}
        </span>
        <CopyToAiButton className="ml-auto" onClick={() => onCopyToAi(finding)} />
      </div>
      {finding.signals.nameSimilarity && (
        <div className="mt-1 text-xs text-zh-muted">
          {t('page.deps.typosquat.resembles', {
            target: finding.signals.nameSimilarity.target,
            score: finding.signals.nameSimilarity.score,
          })}
        </div>
      )}
      {finding.evidence.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {finding.evidence.map((item) => (
            <li key={item} className="text-[11px] text-zh-muted flex gap-1.5">
              <span className="shrink-0">•</span>
              <span className="break-all">{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 投毒检测卡片：可疑依赖清单（风险徽章 + 相似知名包 + 判定证据） */
export function DependencyTyposquatCard({
  report,
  onCopyToAi,
  onCopyAll,
}: {
  report: DependencyReportData;
  onCopyToAi: (finding: TyposquatFindingData) => void;
  onCopyAll: (findings: TyposquatFindingData[]) => void;
}) {
  const t = useT();
  const findings = report.typosquatFindings;
  return (
    <ResultCard variant="score">
      <SectionTitle
        icon={
          <SectionIcon>
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
            <path d="M11 8v3l2 2" />
          </SectionIcon>
        }
        label={t('page.deps.typosquat')}
        right={
          <span className="text-xs text-zh-muted">
            {t('page.deps.typosquat.total', { count: findings.length })}
          </span>
        }
      />
      <AdapterErrorNote
        title={t('page.deps.typosquat.checkFailed')}
        message={report.typosquatError}
      />
      {findings.length === 0 ? (
        <TyposquatEmptyState />
      ) : (
        <>
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-zh-muted">
              {t('page.deps.typosquat.copyAllPrompt', { count: findings.length })}
            </span>
            <CopyAllToAiButton onClick={() => onCopyAll(findings)} />
          </div>
          <div className="space-y-3">
            {findings.map((finding) => (
              <TyposquatFindingItem
                key={finding.nodeId}
                finding={finding}
                onCopyToAi={onCopyToAi}
              />
            ))}
          </div>
        </>
      )}
    </ResultCard>
  );
}

/** 锁文件校验状态行：clean / missing / modified（勾选 / 叉号 + 文案） */
function LockfileStatusRow({ clean, missing }: { clean: boolean; missing: boolean }) {
  const t = useT();
  return (
    <div
      className={`mb-3 flex items-center gap-2 text-sm ${clean ? 'text-success-700' : 'text-danger-600'}`}
    >
      {clean ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      )}
      <span>
        {clean
          ? t('page.deps.lockfileVerify.clean')
          : missing
            ? t('page.deps.lockfileVerify.missing')
            : t('page.deps.lockfileVerify.modified')}
      </span>
    </div>
  );
}

/** 锁文件校验差异清单：声明版本 → 锁定版本 */
function LockfileDiffs({ diffs }: { diffs: LockfileVerificationData['diffs'] }) {
  const t = useT();
  if (diffs.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="text-xs font-medium text-zh-muted mb-2">
        {t('page.deps.lockfileVerify.diffs', { count: diffs.length })}
      </div>
      <div className="space-y-1">
        {diffs.map((diff) => (
          <div key={`${diff.name}:${diff.declaredVersion}`} className="text-[11px] text-zh-muted">
            <span className="font-medium text-zh-ink-2">{diff.name}</span>{' '}
            {diff.declaredVersion} → {diff.lockedVersion || '—'}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 锁文件完整性异常清单 */
function LockfileIntegrityFailures({ failures }: { failures: string[] }) {
  const t = useT();
  if (failures.length === 0) return null;
  return (
    <div>
      <div className="text-xs font-medium text-zh-muted mb-2">
        {t('page.deps.lockfileVerify.integrity', { count: failures.length })}
      </div>
      <ul className="space-y-1">
        {failures.map((failure) => (
          <li key={failure} className="text-[11px] text-danger-500 break-all">
            {failure}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 锁文件完整性校验卡片：状态 + 声明/锁定差异 + 完整性异常 */
export function DependencyLockfileVerificationCard({ report }: { report: DependencyReportData }) {
  const t = useT();
  const verification = report.lockfileVerification;
  const clean = verification.status === 'clean';
  const missing = verification.status === 'missing';
  return (
    <ResultCard variant="score">
      <SectionTitle
        icon={
          <SectionIcon>
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M9 12l2 2 4-4" />
          </SectionIcon>
        }
        label={t('page.deps.lockfileVerify')}
      />
      <AdapterErrorNote
        title={t('page.deps.lockfileVerify.checkFailed')}
        message={report.lockfileError}
      />
      <LockfileStatusRow clean={clean} missing={missing} />
      <LockfileDiffs diffs={verification.diffs} />
      <LockfileIntegrityFailures failures={verification.integrityFailures} />
    </ResultCard>
  );
}

/** 升级评估空态：无候选版本 */
function UpgradeEmptyState() {
  const t = useT();
  return (
    <div className="rounded-xl flex flex-col items-center justify-center py-12 gap-2 bg-zh-panel border border-dashed border-zh-line">
      <span className="text-2xl">🟢</span>
      <span className="text-sm font-medium text-success-700">
        {t('page.deps.upgrade.none')}
      </span>
    </div>
  );
}

/** 升级候选单条：目标版本 + 安全标记 + 风险徽章 + 破坏性变更明细 */
function UpgradeCandidateItem({
  candidate,
}: {
  candidate: UpgradeAssessmentData['candidates'][number];
}) {
  const t = useT();
  const cfg = RISK_BADGE_CONFIG[candidate.risk] ?? RISK_BADGE_CONFIG.low;
  return (
    <div className="rounded-md bg-zh-panel px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-zh-ink-2">v{candidate.targetVersion}</span>
        {candidate.securityRelevant && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-danger-50 text-danger-600">
            {t('page.deps.upgrade.security')}
          </span>
        )}
        <span
          className="ml-auto px-1.5 py-0.5 rounded text-[10px] font-medium"
          style={{ background: cfg.bg, color: cfg.color }}
        >
          {t(cfg.labelKey)}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-zh-muted">{candidate.reason}</div>
      {candidate.breakingChanges.length > 0 && (
        <div className="mt-1.5">
          <div className="text-[10px] font-medium text-zh-muted mb-0.5">
            {t('page.deps.upgrade.breaking')}
          </div>
          <ul className="space-y-0.5">
            {candidate.breakingChanges.map((change) => (
              <li
                key={`${change.type}:${change.description}`}
                className="text-[11px] text-zh-muted flex gap-1.5"
              >
                <span className="shrink-0">•</span>
                <span className="break-all">{change.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 升级评估单条：依赖名 + 候选版本列表 */
function UpgradeAssessmentItem({ assessment }: { assessment: UpgradeAssessmentData }) {
  return (
    <div className="rounded-lg border border-zh-line p-3">
      <div className="text-sm font-medium text-zh-ink-2">{assessment.nodeId}</div>
      <div className="mt-2 space-y-2">
        {assessment.candidates.map((candidate) => (
          <UpgradeCandidateItem key={candidate.targetVersion} candidate={candidate} />
        ))}
      </div>
    </div>
  );
}

/** 升级评估卡片：直接依赖候选版本（安全修复置顶标记 + 破坏性变更明细） */
export function DependencyUpgradeCard({ report }: { report: DependencyReportData }) {
  const t = useT();
  const assessments = report.upgradeAssessments;
  return (
    <ResultCard variant="score">
      <SectionTitle
        icon={
          <SectionIcon>
            <path d="M23 6l-9.5 9.5-5-5L1 18" />
            <path d="M17 6h6v6" />
          </SectionIcon>
        }
        label={t('page.deps.upgrade')}
        right={
          <span className="text-xs text-zh-muted">
            {t('page.deps.upgrade.total', { count: assessments.length })}
          </span>
        }
      />
      <AdapterErrorNote title={t('page.deps.upgrade.checkFailed')} message={report.upgradeError} />
      {assessments.length === 0 ? (
        <UpgradeEmptyState />
      ) : (
        <div className="space-y-3">
          {assessments.map((assessment) => (
            <UpgradeAssessmentItem key={assessment.nodeId} assessment={assessment} />
          ))}
        </div>
      )}
    </ResultCard>
  );
}
