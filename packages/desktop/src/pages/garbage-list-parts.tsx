import type { SecurityScanReportData } from '../types/electron';
import { useT } from '../i18n';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';
import { isCleanableType } from './garbage-logic';

export const GARBAGE_TYPE_LABEL: Record<string, string> = {
  'unused-file': 'page.garbage.type.unusedFile',
  'unused-dependency': 'page.garbage.type.unusedDependency',
  'dead-code': 'page.garbage.type.deadCode',
  'duplicate-code': 'page.garbage.type.duplicateCode',
};

export function formatSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function GarbageStats({ report }: { report: SecurityScanReportData }) {
  const t = useT();
  const items = report.garbage;
  const countByType = items.reduce<Record<string, number>>((acc, g) => {
    acc[g.type] = (acc[g.type] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <ResultCard variant="stats">
        <div className="text-2xl font-bold text-emerald-600">{items.length}</div>
        <div className="text-xs text-zh-muted mt-1">{t('page.garbage.stats.items')}</div>
      </ResultCard>
      <ResultCard variant="stats">
        <div className="text-2xl font-bold text-emerald-600">
          {formatSize(report.summary.garbageSize)}
        </div>
        <div className="text-xs text-zh-muted mt-1">{t('page.garbage.stats.freeable')}</div>
      </ResultCard>
      {(['unused-dependency', 'unused-file'] as const).map((type) => (
        <ResultCard key={type} variant="stats">
          <div className="text-2xl font-bold text-zh-ink-2">{countByType[type] ?? 0}</div>
          <div className="text-xs text-zh-muted mt-1">{t(GARBAGE_TYPE_LABEL[type] ?? type)}</div>
        </ResultCard>
      ))}
    </div>
  );
}

interface GarbageListProps {
  items: SecurityScanReportData['garbage'];
  selected: Set<string>;
  onToggle: (id: string) => void;
}

function GarbageCard({
  item,
  selected,
  onToggle,
}: {
  item: SecurityScanReportData['garbage'][number];
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const t = useT();
  const cleanable = isCleanableType(item.type);
  return (
    <ResultCard>
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={selected}
          disabled={!cleanable}
          onChange={() => cleanable && onToggle(item.id)}
          className="w-4 h-4 rounded border-zh-line text-emerald-600 focus:ring-emerald-500 shrink-0 disabled:opacity-30"
        />
        <span className="px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-700 shrink-0">
          {t(GARBAGE_TYPE_LABEL[item.type] ?? item.type)}
        </span>
        <span className="text-sm font-medium text-zh-ink-2 truncate">{item.path}</span>
        <span className="ml-auto shrink-0 text-xs font-semibold text-emerald-600">
          {formatSize(item.size)}
        </span>
      </div>
      <div className="mt-1 text-xs text-zh-muted pl-7">{item.reason}</div>
      {item.type === 'unused-dependency' && (
        <div className="mt-2 pl-7 text-xs text-amber-700">{t('page.garbage.dependencyHint')}</div>
      )}
    </ResultCard>
  );
}

export function GarbageList({ items, selected, onToggle }: GarbageListProps) {
  const t = useT();
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <GarbageCard
          key={item.id}
          item={item}
          selected={selected.has(item.id)}
          onToggle={onToggle}
        />
      ))}
      {items.length === 0 && (
        <div className="rounded-xl flex flex-col items-center justify-center py-16 gap-2 bg-zh-panel border border-dashed border-zh-line">
          <span className="text-2xl">🧹</span>
          <span className="text-sm font-medium text-green-700">{t('page.garbage.emptyList')}</span>
        </div>
      )}
    </div>
  );
}

interface GarbageActionBarProps {
  items: SecurityScanReportData['garbage'];
  selected: Set<string>;
  onToggleAll: () => void;
  onClean: () => void;
  onCopyAllToAi: () => void;
  cleaning: boolean;
}

export function GarbageActionBar({
  items,
  selected,
  onToggleAll,
  onClean,
  onCopyAllToAi,
  cleaning,
}: GarbageActionBarProps) {
  const t = useT();
  const cleanable = items.filter((i) => isCleanableType(i.type));
  const selectedCount = cleanable.filter((i) => selected.has(i.id)).length;
  const allChecked = cleanable.length > 0 && selectedCount === cleanable.length;
  return (
    <ResultCard variant="item" className="flex items-center gap-4 mb-4">
      <label
        className={`flex items-center gap-2 text-sm text-zh-ink-2 ${cleanable.length === 0 ? 'opacity-40' : 'cursor-pointer'}`}
        title={cleanable.length === 0 ? t('page.garbage.selectAllDisabledHint') : undefined}
      >
        <input
          type="checkbox"
          checked={allChecked}
          onChange={onToggleAll}
          disabled={cleanable.length === 0}
          className="w-4 h-4 rounded border-zh-line text-emerald-600 focus:ring-emerald-500"
        />
        {t('page.garbage.selectAll')}
      </label>
      <span className="text-sm text-zh-muted">
        {t('page.garbage.selectedCount', { count: selectedCount })}
      </span>
      <CopyAllToAiButton
        className="ml-auto"
        label={t('page.garbage.copyAllToAi')}
        onClick={onCopyAllToAi}
      />
      <PrimaryButton
        onClick={onClean}
        disabled={selectedCount === 0}
        loading={cleaning}
        loadingLabel={t('page.garbage.cleaning')}
      >
        {selectedCount > 0
          ? t('page.garbage.cleanButtonCount', { count: selectedCount })
          : t('page.garbage.cleanButton')}
      </PrimaryButton>
    </ResultCard>
  );
}
