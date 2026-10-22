import type { ReactNode } from 'react';
import type { DependencyReportData } from '../types/electron';
import { useT } from '../i18n';
import { ResultCard } from '../components/ui/ResultCard';
import { SectionTitle } from '../components/ui/SectionTitle';
import { SectionIcon } from '../components/ui/Icons';
import { LICENSE_CATEGORY_CONFIG, LICENSE_CATEGORY_ORDER } from './dependency-logic';

/** 计数格：色底 + 大号计数 + 同色圆点标签（信任状态 / 许可证类别两处共用；footer 可选） */
export function ConfigCountTile({
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
