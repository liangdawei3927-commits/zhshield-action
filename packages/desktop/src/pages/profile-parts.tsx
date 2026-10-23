import { useState } from 'react';
import { ResultCard } from '../components/ui/ResultCard';
import { useT } from '../i18n';

type ArchitectureForm = 'monolith' | 'modular-monolith' | 'microservices' | 'unknown';

interface MatchResult<T = string> {
  readonly value: T;
  readonly confidence: number;
  readonly signals: readonly Signal[];
}

interface Signal {
  readonly ruleId: string;
  readonly kind: string;
  readonly file: string;
  readonly weight: number;
  readonly payload: unknown;
}

export interface TargetProfile {
  readonly id: string;
  readonly path: string;
  readonly language: MatchResult;
  readonly frameworks: readonly MatchResult[];
  readonly productForm?: MatchResult;
  readonly packageManager?: MatchResult;
  readonly routeKey: string;
}

export interface UserOverrides {
  readonly architecture?: ArchitectureForm;
  readonly targets?: Readonly<
    Record<string, { readonly language?: string; readonly productForm?: string }>
  >;
  readonly updatedAt?: string;
}

export interface DependencySummary {
  readonly packageManager?: string;
  readonly direct: readonly { readonly name: string; readonly version: string }[];
  readonly lockfilePath?: string;
}

export interface ProjectProfile {
  readonly schemaVersion: number;
  readonly architecture: MatchResult<ArchitectureForm>;
  readonly targets: readonly TargetProfile[];
  readonly environments: readonly MatchResult[];
  readonly dependencies: DependencySummary;
  readonly detectedAt: string;
  readonly lastConfirmedAt?: string;
  readonly stale: boolean;
  readonly signals: readonly Signal[];
  readonly overrides: UserOverrides;
}

// ─── 通用 UI 原语 ────────────────────────────────────────────────────

export function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const colorClass =
    pct >= 90
      ? 'bg-success-100 text-success-800'
      : pct >= 70
        ? 'bg-warning-100 text-warning-800'
        : 'bg-danger-100 text-danger-800';
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${colorClass}`}
    >
      {pct}%
    </span>
  );
}

export function StaleBadge() {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-warning-100 text-warning-800">
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
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
      {t('page.profile.stale')}
    </span>
  );
}

/** 分区容器：统一走 ResultCard variant="section"（与其他检查页卡片同规格） */
export function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <ResultCard variant="section" className="mb-5">
      <h3 className="text-sm font-semibold text-zh-ink mb-4">{title}</h3>
      {children}
    </ResultCard>
  );
}

export function DataRow({
  label,
  value,
  badge,
}: {
  label: string;
  value: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between py-2 border-b border-zh-line/50 last:border-b-0">
      <span className="text-xs text-zh-muted shrink-0 mr-4">{label}</span>
      <span className="text-xs text-zh-ink text-right flex items-center gap-2">
        {value}
        {badge}
      </span>
    </div>
  );
}

// ─── 信号列表 ────────────────────────────────────────────────────────

export function SignalList({ signals }: { signals: readonly Signal[] }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? signals : signals.slice(0, 5);

  if (signals.length === 0) return <p className="text-xs text-zh-muted">{t('page.profile.signals.none')}</p>;

  return (
    <div>
      <div className="space-y-1.5">
        {shown.map((sig, i) => (
          <div key={i} className="flex items-center gap-2 text-[11px] py-1">
            <span className="shrink-0 px-1.5 py-0.5 rounded bg-zh-bg text-zh-muted font-mono">
              {sig.kind}
            </span>
            <span className="text-zh-ink font-mono truncate">{sig.ruleId}</span>
            <span className="text-zh-muted shrink-0">{sig.file}</span>
          </div>
        ))}
      </div>
      {signals.length > 5 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-2 text-[11px] text-info-600 hover:text-info-800 bg-transparent border-none cursor-pointer p-0"
        >
          {expanded
            ? t('page.profile.signals.collapse')
            : t('page.profile.signals.expand', { count: signals.length })}
        </button>
      )}
    </div>
  );
}

// ─── 目标卡片 ────────────────────────────────────────────────────────

/** 目标框架徽章列表：每个框架值 + 置信度徽章（右对齐换行） */
function TargetFrameworkList({ frameworks }: { frameworks: readonly MatchResult[] }) {
  return (
    <span className="flex flex-wrap gap-1 justify-end">
      {frameworks.map((fw, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          <span>{fw.value}</span>
          <ConfidenceBadge confidence={fw.confidence} />
        </span>
      ))}
    </span>
  );
}

export function TargetCard({ target }: { target: TargetProfile }) {
  const t = useT();
  return (
    <ResultCard variant="section" className="mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-zh-ink">{target.id}</span>
          <span className="text-[11px] text-zh-muted font-mono">{target.path}</span>
        </div>
        <span className="text-[11px] font-mono text-zh-muted bg-zh-bg px-2 py-0.5 rounded">
          {target.routeKey}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-6">
        <DataRow
          label={t('page.profile.target.language')}
          value={target.language.value}
          badge={<ConfidenceBadge confidence={target.language.confidence} />}
        />
        <DataRow label={t('page.profile.target.frameworks')} value={<TargetFrameworkList frameworks={target.frameworks} />} />
        {target.productForm && (
          <DataRow
            label={t('page.profile.target.productForm')}
            value={target.productForm.value}
            badge={<ConfidenceBadge confidence={target.productForm.confidence} />}
          />
        )}
        {target.packageManager && (
          <DataRow
            label={t('page.profile.target.packageManager')}
            value={target.packageManager.value}
            badge={<ConfidenceBadge confidence={target.packageManager.confidence} />}
          />
        )}
      </div>

      {target.language.signals.length > 0 && (
        <div className="mt-3 pt-3 border-t border-zh-line/50">
          <p className="text-[11px] text-zh-muted mb-2">{t('page.profile.target.languageBasis')}</p>
          <SignalList signals={target.language.signals} />
        </div>
      )}
    </ResultCard>
  );
}

// ─── 覆写信息 ────────────────────────────────────────────────────────

export function OverridesPanel({ overrides }: { overrides: UserOverrides }) {
  const t = useT();
  const hasOverrides = overrides.architecture || overrides.targets;

  if (!hasOverrides) {
    return (
      <div className="text-center py-4">
        <p className="text-xs text-zh-muted">{t('page.profile.overrides.none')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {overrides.architecture && (
        <DataRow label={t('page.profile.overrides.architecture')} value={overrides.architecture} />
      )}
      {overrides.targets &&
        Object.entries(overrides.targets).map(([key, val]) => (
          <DataRow
            key={key}
            label={t('page.profile.overrides.target', { key })}
            value={
              <span className="text-[11px] font-mono">
                {val.language && t('page.profile.overrides.language', { value: val.language })}
                {val.language && val.productForm && ' / '}
                {val.productForm && t('page.profile.overrides.productForm', { value: val.productForm })}
              </span>
            }
          />
        ))}
      {overrides.updatedAt && (
        <p className="text-[11px] text-zh-muted mt-2">
          {t('page.profile.overrides.updatedAt', {
            time: new Date(overrides.updatedAt).toLocaleString(),
          })}
        </p>
      )}
    </div>
  );
}
