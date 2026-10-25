import {
  type RefactorFile,
  type Smell,
  type SmellGroup,
  SEVERITY_COLORS,
  SEVERITY_LABELS,
} from './refactor-logic';
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
        <p className="text-xs mt-1 text-info-700">
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
          <span className="px-2 py-0.5 rounded text-xs font-semibold text-white bg-info-600 shrink-0">
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

/** 文件级优先级徽标样式（critical/high/medium/low） */
const PRIORITY_STYLE: Record<string, { key: string; fallback: string; bg: string }> = {
  critical: {
    key: 'page.refactor.priority.critical',
    fallback: '紧急',
    bg: 'rgb(var(--zh-danger))',
  },
  high: { key: 'page.refactor.priority.high', fallback: '高', bg: 'rgb(var(--zh-warning))' },
  medium: { key: 'page.refactor.priority.medium', fallback: '中', bg: 'rgb(var(--zh-info))' },
  low: { key: 'page.refactor.priority.low', fallback: '低', bg: 'rgb(var(--zh-muted))' },
};

/** 明细空态：卡片数字与明细子集本应同源，为空时必须显式说明而不是留白 */
function DetailEmpty() {
  const t = useT();
  return (
    <p className="text-xs text-zh-muted py-2">
      {t('page.refactor.detail.empty', { defaultValue: '该分类下暂无明细' })}
    </p>
  );
}

/**
 * 「代码异味」统计卡明细：跨规则平铺全部异味。
 *
 * 与下方「按类型分组」面板是两种视角（全量流水 vs 分类聚合），故不复用
 * `SmellGroupPanel`，只复用 `SmellRow` 保证单条样式一致。
 *
 * 受 `MAX_DETAIL_SMELLS` 截断：单卡明细是手风琴内联渲染，异味量大时（自家库
 * 实测可达数千条）全量铺开会拖死 8GB 机器，且下方分组面板才是浏览全量的入口。
 * 截断时必须显式告知「只显示前 N 条」，不能悄悄少渲染。
 */
const MAX_DETAIL_SMELLS = 200;

export function SmellDetailList({
  items,
  onCopyItem,
}: {
  items: Smell[];
  onCopyItem: (smell: Smell) => void;
}) {
  const t = useT();
  if (items.length === 0) return <DetailEmpty />;
  const shown = items.slice(0, MAX_DETAIL_SMELLS);
  return (
    <div className="flex flex-col gap-2">
      {shown.map((smell, i) => (
        <SmellRow
          // 跨文件平铺后 smell.id 不保证唯一（检测器按单文件生成）⇒ 补位置与序号
          key={`${smell.location.filePath}:${smell.location.line}:${smell.ruleId}:${i}`}
          smell={smell}
          onCopy={() => onCopyItem(smell)}
        />
      ))}
      {items.length > shown.length ? (
        <p className="text-xs text-zh-muted pt-1">
          {t('page.refactor.detail.truncated', {
            defaultValue: '仅显示前 {{shown}} 条，完整清单见下方「重构问题（按类型分组）」',
            shown: shown.length,
            total: items.length,
          })}
        </p>
      ) : null}
    </div>
  );
}

/** 「需重构文件 / 高优先级」统计卡明细：文件行（优先级 + 路径 + 异味数 + 可维护性） */
export function RefactorFileDetailList({ files }: { files: RefactorFile[] }) {
  const t = useT();
  if (files.length === 0) return <DetailEmpty />;
  return (
    <div className="flex flex-col gap-2">
      {files.map((file) => {
        const priority = PRIORITY_STYLE[file.refactorPriority] ?? PRIORITY_STYLE.low;
        return (
          <div
            key={file.filePath}
            className="flex items-center gap-3 p-3 rounded-lg bg-zh-panel"
          >
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-bold text-white shrink-0"
              style={{ background: priority.bg }}
            >
              {t(priority.key, { defaultValue: priority.fallback })}
            </span>
            <p className="flex-1 min-w-0 text-[11px] text-zh-muted font-mono truncate">
              {file.filePath}
            </p>
            <span className="text-xs text-zh-ink-2 shrink-0">
              {t('page.refactor.smellCount', { count: file.totalSmells })}
            </span>
            <span className="text-[11px] text-zh-muted shrink-0">
              {t('page.refactor.maintainability', { defaultValue: '可维护性' })}
              {file.maintainabilityScore}
            </span>
          </div>
        );
      })}
    </div>
  );
}
