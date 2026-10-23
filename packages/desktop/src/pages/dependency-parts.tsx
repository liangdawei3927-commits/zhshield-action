import type { DependencyReportData } from '../types/electron';
import { PipelineTaskEmptyState } from '../components/business/PipelineTaskEmptyState';
import { useT } from '../i18n';
import { ResultCard } from '../components/ui/ResultCard';
import { SectionTitle } from '../components/ui/SectionTitle';
import { BrandMarkIcon, FeatureIcon, SectionIcon } from '../components/ui/Icons';
import {
  TRUST_STATUS_CONFIG,
  TRUST_STATUS_ORDER,
  LOCKFILE_CHECKS,
  resolveLockfileCheck,
  ENV_SEVERITY_CONFIG,
} from './dependency-logic';
import type { LockfileCheckState } from './dependency-logic';
import { AdapterErrorNote } from './dependency-cards';
import { ConfigCountTile } from './dependency-parts-license';
// 许可证卡片下沉到独立子模块，此处保留原导出路径，调用方无需改动
export { DependencyLicenseCard } from './dependency-parts-license';

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

/** 锁文件单项校验形态：三态图标（勾选 / 灰点 / 叉号）+ 状态文案 */
function LockfileCheckRow({
  state,
  check,
}: {
  state: LockfileCheckState;
  check: (typeof LOCKFILE_CHECKS)[number];
}) {
  const t = useT();
  const ok = state === 'ok';
  const na = state === 'na';
  return (
    <div className="flex items-center gap-3">
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
        {LOCKFILE_CHECKS.map((check) => (
          <LockfileCheckRow
            key={check.key}
            state={resolveLockfileCheck(lockfile, check.key)}
            check={check}
          />
        ))}
      </div>
    </ResultCard>
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
      taskKind="deps"
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
