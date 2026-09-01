import { type Smell, type SmellGroup, SEVERITY_COLORS, SEVERITY_LABELS } from './refactor-logic';
import { useT } from '../i18n';
import { BounceCard } from '../components/ui/Bounce';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyToAiButton } from '../components/ui/CopyToAiButton';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';

function SmellRow({ smell, onCopy }: { smell: Smell; onCopy: () => void }) {
  const t = useT();
  return (
    <BounceCard className="flex items-start gap-3 p-3 rounded-lg bg-zh-panel">
      <span
        className="px-1.5 py-0.5 rounded text-[10px] font-bold text-white shrink-0 mt-0.5"
        style={{ background: SEVERITY_COLORS[smell.severity] || 'rgb(var(--zh-muted))' }}
      >
        {t(SEVERITY_LABELS[smell.severity] || smell.severity)}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-zh-muted font-mono truncate">
          {smell.location.filePath}
          {smell.location.line ? `:${smell.location.line}` : ''}
        </p>
        <p className="text-xs text-zh-ink-2 mt-0.5">{smell.message}</p>
        <p className="text-xs mt-1 text-blue-700">
          {t('page.refactor.suggestion', { suggestion: smell.suggestion.description })}
        </p>
      </div>
      <CopyToAiButton className="shrink-0" onClick={onCopy} />
    </BounceCard>
  );
}

export function SmellGroupPanel({
  group,
  onCopyGroup,
  onCopyItem,
}: {
  group: SmellGroup;
  onCopyGroup: () => void;
  onCopyItem: (smell: Smell) => void;
}) {
  const t = useT();
  return (
    <ResultCard variant="score">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <span className="px-2 py-0.5 rounded text-xs font-semibold text-white bg-blue-600 shrink-0">
            {t(group.label)}
          </span>
          <span className="text-xs text-zh-muted shrink-0">
            {t('page.refactor.smellCount', { count: group.items.length })}
          </span>
          {group.technique && group.technique !== group.label ? (
            <span className="text-[11px] text-zh-muted bg-zh-panel px-2 py-0.5 rounded truncate">
              {group.technique}
            </span>
          ) : null}
        </div>
        <CopyAllToAiButton onClick={onCopyGroup} />
      </div>
      <div className="flex flex-col gap-2">
        {group.items.map((smell) => (
          <SmellRow key={smell.id} smell={smell} onCopy={() => onCopyItem(smell)} />
        ))}
      </div>
    </ResultCard>
  );
}
