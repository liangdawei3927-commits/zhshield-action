import type { ReactNode } from 'react';
import type { DependencyReportData, TyposquatFindingData } from '../types/electron';
import { PipelineTaskEmptyState } from '../components/business/PipelineTaskEmptyState';
import { useT } from '../i18n';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyToAiButton } from '../components/ui/CopyToAiButton';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';
import { SectionTitle } from '../components/ui/SectionTitle';
import { BrandMarkIcon, FeatureIcon, SectionIcon } from '../components/ui/Icons';
import {
  LICENSE_CATEGORY_CONFIG,
  LICENSE_CATEGORY_ORDER,
  TRUST_STATUS_CONFIG,
  TRUST_STATUS_ORDER,
  LOCKFILE_CHECKS,
  resolveLockfileCheck,
  RISK_BADGE_CONFIG,
  ENV_SEVERITY_CONFIG,
} from './dependency-logic';

/** 依赖图谱 SVG 字形（24×24 线性风格；尺寸/描边由宿主 `<svg>` 决定） */
export function DependencyGraphGlyph() {
  return (
    <>
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5" cy="18" r="2.5" />
      <circle cx="19" cy="18" r="2.5" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 7.5V9.5" />
      <path d="M10.5 12H7.5" />
      <path d="M13.5 12h3" />
      <path d="M6.5 16.5l2-2" />
      <path d="M17.5 16.5l-2-2" />
    </>
  );
}

/** 依赖图谱小图标（BrandMarkIcon 包裹） */
function DependencyGraphIcon() {
  return (
    <BrandMarkIcon>
      <DependencyGraphGlyph />
    </BrandMarkIcon>
  );
}

/** 锁文件状态卡片：存在性 / 一致性 / 哈希完整性（勾选 / 叉号 + 文案） */
export function DependencyLockfileCard({
  lockfile,
}: {
  lockfile: DependencyReportData['lockfile'];
}) {
  const t = useT();
  return (
    <ResultCard variant="score">
      <SectionTitle
        icon={
          <SectionIcon>
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 018 0v3" />
            <circle cx="12" cy="16" r="1" />
          </SectionIcon>
        }
        label={t('page.deps.lockfile')}
      />
      <div className="space-y-3">
        {LOCKFILE_CHECKS.map((check) => {
          const state = resolveLockfileCheck(lockfile, check.key);
          const ok = state === 'ok';
          const na = state === 'na';
          return (
            <div key={check.key} className="flex items-center gap-3">
              <span
                className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${ok ? 'bg-success-50' : na ? 'bg-zh-panel' : 'bg-danger-50'}`}
              >
                {ok ? (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="rgb(var(--zh-success-700))"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                ) : na ? (
                  <span className="w-1.5 h-1.5 rounded-full bg-zh-muted" />
                ) : (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="rgb(var(--zh-danger))"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                )}
              </span>
              <span
                className={`text-sm ${ok ? 'text-success-700' : na ? 'text-zh-muted' : 'text-danger-600'}`}
              >
                {t(ok ? check.okKey : na ? check.naKey : check.failKey)}
              </span>
            </div>
          );
        })}
      </div>
    </ResultCard>
  );
}

/** 计数格：色底 + 大号计数 + 同色圆点标签（信任状态 / 许可证类别两处共用；footer 可选） */
function ConfigCountTile({
  bg,
  color,
  count,
  label,
  footer,
}: {
  bg: string;
  color: string;
  count: number;
  label: string;
  footer?: ReactNode;
}) {
  return (
    <div className="rounded-lg px-3 py-2.5" style={{ background: bg }}>
      <div className="text-xl font-bold leading-none" style={{ color }}>
        {count}
      </div>
      <div className="text-[11px] mt-1 flex items-center gap-1.5" style={{ color }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
        {label}
      </div>
      {footer}
    </div>
  );
}

/** 信任状态统计卡片：verified / suspicious / compromised / unknown（四色） */
export function DependencyTrustCard({
  trustCounts,
}: {
  trustCounts: DependencyReportData['trustCounts'];
}) {
  const t = useT();
  return (
    <ResultCard variant="score">
      <SectionTitle
        icon={
          <SectionIcon>
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </SectionIcon>
        }
        label={t('page.deps.trust')}
      />
      <div className="grid grid-cols-2 gap-3">
        {TRUST_STATUS_ORDER.map((status) => {
          const cfg = TRUST_STATUS_CONFIG[status];
          const count = trustCounts[status] ?? 0;
          return (
            <ConfigCountTile
              key={status}
              bg={cfg.bg}
              color={cfg.color}
              count={count}
              label={t(cfg.labelKey)}
            />
          );
        })}
      </div>
    </ResultCard>
  );
}

/** 高风险许可证单条：名称 + 版本 + 许可证 + 原因 */
function HighRiskEntry({
  entry,
}: {
  entry: DependencyReportData['licenseMatrix']['entries'][number];
}) {
  const t = useT();
  const cfg = LICENSE_CATEGORY_CONFIG[entry.category] ?? LICENSE_CATEGORY_CONFIG.unknown;
  return (
    <ResultCard>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-zh-ink-2">{entry.name}</span>
        <span className="text-xs text-zh-muted">v{entry.version}</span>
        <span
          className="ml-auto px-2 py-0.5 rounded text-xs font-medium"
          style={{ background: cfg.bg, color: cfg.color }}
        >
          {entry.license || t('page.deps.license.unknown')}
        </span>
      </div>
      <div className="mt-1 text-xs text-zh-muted">{entry.reason || t(cfg.riskKey)}</div>
    </ResultCard>
  );
}

/** 许可证矩阵卡片：四类计数（风险色标）+ 高风险清单 */
export function DependencyLicenseCard({
  matrix,
}: {
  matrix: DependencyReportData['licenseMatrix'];
}) {
  const t = useT();
  const highRiskEntries = matrix.entries.filter((entry) => entry.risk === 'high');
  return (
    <ResultCard variant="score">
      <SectionTitle
        icon={
          <SectionIcon>
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M9 15h6M9 11h2" />
          </SectionIcon>
        }
        label={t('page.deps.license')}
        right={
          <span className="text-xs text-zh-muted">
            {t('page.deps.licenseTotal', { count: matrix.total })}
          </span>
        }
      />
      <div className="grid grid-cols-4 gap-3 mb-6">
        {LICENSE_CATEGORY_ORDER.map((category) => {
          const cfg = LICENSE_CATEGORY_CONFIG[category];
          const count = matrix.byCategory[category] ?? 0;
          return (
            <ConfigCountTile
              key={category}
              bg={cfg.bg}
              color={cfg.color}
              count={count}
              label={t(cfg.labelKey)}
              footer={<div className="text-[10px] text-zh-muted mt-0.5">{t(cfg.riskKey)}</div>}
            />
          );
        })}
      </div>
      <div className="text-xs font-medium text-zh-muted mb-3">{t('page.deps.licenseHighRisk')}</div>
      <div className="space-y-3">
        {highRiskEntries.map((entry) => (
          <HighRiskEntry key={`${entry.name}@${entry.version}`} entry={entry} />
        ))}
        {highRiskEntries.length === 0 && (
          <div className="rounded-xl flex flex-col items-center justify-center py-12 gap-2 bg-zh-panel border border-dashed border-zh-line">
            <span className="text-2xl">🟢</span>
            <span className="text-sm font-medium text-success-700">
              {t('page.deps.licenseNoRisks')}
            </span>
          </div>
        )}
      </div>
    </ResultCard>
  );
}

/** 适配器失败提示条（对应各 error 字段；未失败时不渲染） */
function AdapterErrorNote({ title, message }: { title: string; message?: string }) {
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
        <div className="rounded-xl flex flex-col items-center justify-center py-12 gap-2 bg-zh-panel border border-dashed border-zh-line">
          <span className="text-2xl">🛡️</span>
          <span className="text-sm font-medium text-success-700">
            {t('page.deps.typosquat.none')}
          </span>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-zh-muted">
              {t('page.deps.typosquat.copyAllPrompt', { count: findings.length })}
            </span>
            <CopyAllToAiButton onClick={() => onCopyAll(findings)} />
          </div>
          <div className="space-y-3">
            {findings.map((finding) => {
              const cfg = RISK_BADGE_CONFIG[finding.risk] ?? RISK_BADGE_CONFIG.low;
              return (
                <div key={finding.nodeId} className="rounded-lg border border-zh-line p-3">
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
            })}
          </div>
        </>
      )}
    </ResultCard>
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
      {verification.diffs.length > 0 && (
        <div className="mb-3">
          <div className="text-xs font-medium text-zh-muted mb-2">
            {t('page.deps.lockfileVerify.diffs', { count: verification.diffs.length })}
          </div>
          <div className="space-y-1">
            {verification.diffs.map((diff) => (
              <div
                key={`${diff.name}:${diff.declaredVersion}`}
                className="text-[11px] text-zh-muted"
              >
                <span className="font-medium text-zh-ink-2">{diff.name}</span>{' '}
                {diff.declaredVersion} → {diff.lockedVersion || '—'}
              </div>
            ))}
          </div>
        </div>
      )}
      {verification.integrityFailures.length > 0 && (
        <div>
          <div className="text-xs font-medium text-zh-muted mb-2">
            {t('page.deps.lockfileVerify.integrity', {
              count: verification.integrityFailures.length,
            })}
          </div>
          <ul className="space-y-1">
            {verification.integrityFailures.map((failure) => (
              <li key={failure} className="text-[11px] text-danger-500 break-all">
                {failure}
              </li>
            ))}
          </ul>
        </div>
      )}
    </ResultCard>
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
        <div className="rounded-xl flex flex-col items-center justify-center py-12 gap-2 bg-zh-panel border border-dashed border-zh-line">
          <span className="text-2xl">🟢</span>
          <span className="text-sm font-medium text-success-700">
            {t('page.deps.upgrade.none')}
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          {assessments.map((assessment) => (
            <div key={assessment.nodeId} className="rounded-lg border border-zh-line p-3">
              <div className="text-sm font-medium text-zh-ink-2">{assessment.nodeId}</div>
              <div className="mt-2 space-y-2">
                {assessment.candidates.map((candidate) => {
                  const cfg = RISK_BADGE_CONFIG[candidate.risk] ?? RISK_BADGE_CONFIG.low;
                  return (
                    <div key={candidate.targetVersion} className="rounded-md bg-zh-panel px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-zh-ink-2">
                          v{candidate.targetVersion}
                        </span>
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
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </ResultCard>
  );
}

export function DependencyOutdatedCard({ report }: { report: DependencyReportData }) {
  const t = useT();
  const outdatedDeps = report.outdatedDeps ?? [];
  return (
    <ResultCard variant="score">
      <SectionTitle
        icon={
          <SectionIcon>
            <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            <path d="M9 12l2 2 4-4" />
          </SectionIcon>
        }
        label={t('page.deps.outdated')}
        right={
          <span className="text-xs text-zh-muted">
            {t('page.deps.outdated.total', { count: outdatedDeps.length })}
          </span>
        }
      />
      {outdatedDeps.length === 0 ? (
        <div className="rounded-xl flex flex-col items-center justify-center py-12 gap-2 bg-zh-panel border border-dashed border-zh-line">
          <span className="text-2xl">✅</span>
          <span className="text-sm font-medium text-success-700">
            {t('page.deps.outdated.none')}
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          {outdatedDeps.map((dep) => (
            <div key={dep.name} className="rounded-lg border border-zh-line p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zh-ink-2">{dep.name}</span>
                <span className="text-xs text-zh-muted">
                  {dep.current} → <span className="text-success-600 font-medium">{dep.latest}</span>
                </span>
                {dep.isSecurityUpdate && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-danger-50 text-danger-600">
                    {t('page.deps.outdated.security')}
                  </span>
                )}
              </div>
              {dep.description && (
                <div className="mt-1 text-[11px] text-zh-muted">{dep.description}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </ResultCard>
  );
}

/** 环境一致性卡片：锁文件漂移 / 运行时版本 / 环境变量 / CI 差异条目 */
export function DependencyEnvCard({ report }: { report: DependencyReportData }) {
  const t = useT();
  const entries = report.envEntries;
  return (
    <ResultCard variant="score">
      <SectionTitle
        icon={
          <SectionIcon>
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </SectionIcon>
        }
        label={t('page.deps.env')}
        right={
          <span className="text-xs text-zh-muted">
            {t('page.deps.env.total', { count: entries.length })}
          </span>
        }
      />
      <AdapterErrorNote title={t('page.deps.env.checkFailed')} message={report.envError} />
      {entries.length === 0 ? (
        <div className="rounded-xl flex flex-col items-center justify-center py-12 gap-2 bg-zh-panel border border-dashed border-zh-line">
          <span className="text-2xl">🟢</span>
          <span className="text-sm font-medium text-success-700">{t('page.deps.env.none')}</span>
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => {
            const cfg = ENV_SEVERITY_CONFIG[entry.severity] ?? ENV_SEVERITY_CONFIG.info;
            return (
              <div
                key={`${entry.kind}:${entry.name}`}
                className="rounded-lg border border-zh-line p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-zh-ink-2">
                    {t(`page.deps.env.kind.${entry.kind}`)}
                  </span>
                  <span className="text-[11px] text-zh-muted">· {entry.name}</span>
                  <span
                    className="ml-auto px-1.5 py-0.5 rounded text-[10px] font-medium"
                    style={{ background: cfg.bg, color: cfg.color }}
                  >
                    {t(cfg.labelKey)}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-zh-muted break-all">{entry.detail}</div>
                <div className="mt-0.5 text-[11px] text-zh-muted">
                  {t('page.deps.env.expected', { value: entry.expected })} ·{' '}
                  {t('page.deps.env.actual', { value: entry.actual })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ResultCard>
  );
}

/** 空态：引导依赖管家 */
export function DependencyEmptyState({
  projectPath,
  loading,
  onScan,
}: {
  projectPath: string;
  loading: boolean;
  onScan: () => void;
}) {
  const t = useT();
  return (
    <PipelineTaskEmptyState
      projectPath={projectPath}
      dimension="dependencies"
      titleKey="page.deps.empty.title"
      subtitleKey="page.deps.empty.subtitle"
      buttonTextKey="page.deps.empty.start"
      progressLabelKey="page.deps.checking"
      loading={loading}
      onScan={onScan}
      featureList={[
        {
          icon: <DependencyGraphIcon />,
          title: t('page.deps.feature.graph.title'),
          desc: t('page.deps.feature.graph.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V8a4 4 0 018 0v3" />
              <circle cx="12" cy="16" r="1" />
            </FeatureIcon>
          ),
          title: t('page.deps.feature.lockfile.title'),
          desc: t('page.deps.feature.lockfile.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M9 15h6M9 11h2" />
            </FeatureIcon>
          ),
          title: t('page.deps.feature.license.title'),
          desc: t('page.deps.feature.license.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="M12 8v4M12 16h.01" />
            </FeatureIcon>
          ),
          title: t('page.deps.feature.security.title'),
          desc: t('page.deps.feature.security.desc'),
        },
      ]}
    />
  );
}
