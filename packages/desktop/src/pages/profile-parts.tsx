import { useState } from 'react';

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
  readonly targets?: Readonly<Record<string, { readonly language?: string; readonly productForm?: string }>>;
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
  const colorClass = pct >= 90
    ? 'bg-green-100 text-green-800'
    : pct >= 70
      ? 'bg-amber-100 text-amber-800'
      : 'bg-red-100 text-red-800';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${colorClass}`}>
      {pct}%
    </span>
  );
}

export function StaleBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
      画像已过期
    </span>
  );
}

export function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-zh-card rounded-xl border border-zh-line p-5 mb-5">
      <h3 className="text-sm font-semibold text-zh-ink mb-4">{title}</h3>
      {children}
    </div>
  );
}

export function DataRow({ label, value, badge }: { label: string; value: React.ReactNode; badge?: React.ReactNode }) {
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
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? signals : signals.slice(0, 5);

  if (signals.length === 0) return <p className="text-xs text-zh-muted">无支撑信号</p>;

  return (
    <div>
      <div className="space-y-1.5">
        {shown.map((sig, i) => (
          <div key={i} className="flex items-center gap-2 text-[11px] py-1">
            <span className="shrink-0 px-1.5 py-0.5 rounded bg-zh-bg text-zh-muted font-mono">{sig.kind}</span>
            <span className="text-zh-ink font-mono truncate">{sig.ruleId}</span>
            <span className="text-zh-muted shrink-0">{sig.file}</span>
          </div>
        ))}
      </div>
      {signals.length > 5 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-2 text-[11px] text-blue-600 hover:text-blue-800 bg-transparent border-none cursor-pointer p-0"
        >
          {expanded ? '收起' : `展开全部 (${signals.length})`}
        </button>
      )}
    </div>
  );
}

// ─── 目标卡片 ────────────────────────────────────────────────────────

export function TargetCard({ target }: { target: TargetProfile }) {
  return (
    <div className="bg-zh-card rounded-xl border border-zh-line p-5 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-zh-ink">{target.id}</span>
          <span className="text-[11px] text-zh-muted font-mono">{target.path}</span>
        </div>
        <span className="text-[11px] font-mono text-zh-muted bg-zh-bg px-2 py-0.5 rounded">{target.routeKey}</span>
      </div>

      <div className="grid grid-cols-2 gap-x-6">
        <DataRow
          label="语言"
          value={target.language.value}
          badge={<ConfidenceBadge confidence={target.language.confidence} />}
        />
        <DataRow label="框架" value={
          <span className="flex flex-wrap gap-1 justify-end">
            {target.frameworks.map((fw, i) => (
              <span key={i} className="inline-flex items-center gap-1">
                <span>{fw.value}</span>
                <ConfidenceBadge confidence={fw.confidence} />
              </span>
            ))}
          </span>
        } />
        {target.productForm && (
          <DataRow
            label="交付形态"
            value={target.productForm.value}
            badge={<ConfidenceBadge confidence={target.productForm.confidence} />}
          />
        )}
        {target.packageManager && (
          <DataRow
            label="包管理器"
            value={target.packageManager.value}
            badge={<ConfidenceBadge confidence={target.packageManager.confidence} />}
          />
        )}
      </div>

      {target.language.signals.length > 0 && (
        <div className="mt-3 pt-3 border-t border-zh-line/50">
          <p className="text-[11px] text-zh-muted mb-2">语言判定依据</p>
          <SignalList signals={target.language.signals} />
        </div>
      )}
    </div>
  );
}

// ─── 覆写信息 ────────────────────────────────────────────────────────

export function OverridesPanel({ overrides }: { overrides: UserOverrides }) {
  const hasOverrides = overrides.architecture || overrides.targets;

  if (!hasOverrides) {
    return (
      <div className="text-center py-4">
        <p className="text-xs text-zh-muted">暂无人工修正记录</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {overrides.architecture && (
        <DataRow label="架构修正" value={overrides.architecture} />
      )}
      {overrides.targets && Object.entries(overrides.targets).map(([key, val]) => (
        <DataRow
          key={key}
          label={`目标修正: ${key}`}
          value={
            <span className="text-[11px] font-mono">
              {val.language && `语言=${val.language}`}
              {val.language && val.productForm && ' / '}
              {val.productForm && `形态=${val.productForm}`}
            </span>
          }
        />
      ))}
      {overrides.updatedAt && (
        <p className="text-[11px] text-zh-muted mt-2">最后修正：{new Date(overrides.updatedAt).toLocaleString()}</p>
      )}
    </div>
  );
}
