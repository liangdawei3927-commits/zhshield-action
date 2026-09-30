import { useT } from '../i18n';
import { Bounce } from '../components/ui/Bounce';
import { type SmellGroup } from './refactor-logic';

export function RuleTabs({
  groups,
  activeRuleId,
  onSelect,
}: {
  groups: SmellGroup[];
  activeRuleId: string;
  onSelect: (ruleId: string) => void;
}) {
  const t = useT();
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {groups.map((group) => {
        const isActive = group.ruleId === activeRuleId;
        return (
          <Bounce
            as="button"
            key={group.ruleId}
            onClick={() => onSelect(group.ruleId)}
            className={`shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium border-none cursor-pointer transition-colors ${
              isActive ? 'bg-info-600 text-white' : 'bg-zh-panel text-zh-ink-2 hover:bg-zh-line'
            }`}
          >
            {t(group.label)}
            <span
              className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                isActive ? 'bg-white/25 text-white' : 'bg-info-50 text-info-700'
              }`}
            >
              {group.items.length}
            </span>
          </Bounce>
        );
      })}
    </div>
  );
}
