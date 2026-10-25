/**
 * 「分数变化归因」的展示块（汇总 / 对账条 / 警示条 / 区间选择器 / 脚注）。
 *
 * 从 `report-attribution-parts.tsx` 按职责拆出：这里只负责"把已算好的结果画出来"，
 * 不含任何数学（数学全在 `report-attribution.ts`，已单测钉住恒等式）。
 * 逐域明细表在 `report-attribution-table.tsx`。
 *
 * 分块口径与拆分前完全一致：结构项 / 封顶项单独成行，对不上账就标红。
 */

import type { AttributionBreakdown, AttributionUnavailable } from './report-attribution';
import { deltaColor, dimensionName, formatDelta } from './reports-logic';
import { useT } from '../i18n';

/** 算不了归因时的原因文案（跨评分版本 / 维度构成不同 / 缺权重 / 无已检测域） */
export function unavailableMessage(reason: AttributionUnavailable): string {
  switch (reason) {
    case 'version-mismatch':
      return '这两次记录来自不同评分算法版本，维度构成与扣分口径都变了，分数不能直接相减，因此不做归因。';
    case 'dimension-set-mismatch':
      return '这两次记录的维度构成不同（某些维度只在其中一次里存在），无法逐域对齐，因此不做归因。';
    case 'missing-weight':
      return '该记录缺少维度权重信息，无法计算各域贡献。刷新一次检查后新记录会带上权重。';
    case 'no-active-dimension':
      return '其中一次没有任何已检测的域（全部未运行），无法在加权口径下比较。';
  }
}

/** 一串「维度名 + 贡献值」chip */
function DomainChips({
  domains,
  emptyLabel,
}: {
  domains: readonly { name: string; points: number }[];
  emptyLabel: string;
}) {
  const t = useT();
  if (domains.length === 0) {
    return <span className="text-[11px] text-zh-muted">{emptyLabel}</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {domains.map((domain) => (
        <span key={domain.name} className="inline-flex items-baseline gap-1 text-[11px]">
          <span className="text-zh-muted">{dimensionName(domain.name, t)}</span>
          <span className="font-bold" style={{ color: deltaColor(domain.points) }}>
            {formatDelta(domain.points)}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * 对账条：域贡献 + 结构项 + 封顶项 = 实际变化。
 *
 * 这一行是整块的可信度锚点。对不上必须标红 —— 一个能自证的归因才有资格被拿去改代码。
 */
export function ReconcileBar({ result }: { result: AttributionBreakdown }) {
  const t = useT();
  const parts: Array<{ key: string; label: string; value: number }> = [
    { key: 'domains', label: t('page.reports.attribution.part.domains', { defaultValue: '域贡献' }), value: result.domainsPoints },
  ];
  if (Math.abs(result.structurePoints) >= 0.01) {
    parts.push({ key: 'structure', label: t('page.reports.attribution.part.structure', { defaultValue: '结构项' }), value: result.structurePoints });
  }
  if (Math.abs(result.capPoints) >= 0.01) {
    parts.push({ key: 'cap', label: t('page.reports.attribution.part.cap', { defaultValue: '封顶项' }), value: result.capPoints });
  }
  const sum = parts.reduce((acc, part) => acc + part.value, 0);
  const ok = result.reconciled;
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 text-[11px]"
      style={{
        background: ok ? 'rgb(var(--zh-panel))' : 'rgb(var(--zh-danger) / 0.08)',
        border: `1px solid ${ok ? 'rgb(var(--zh-line))' : 'rgb(var(--zh-danger) / 0.35)'}`,
      }}
    >
      {parts.map((part, index) => (
        <span key={part.key} className="inline-flex items-baseline gap-1">
          {index > 0 && <span className="text-zh-muted">+</span>}
          <span className="text-zh-muted">{part.label}</span>
          <span className="font-bold font-mono" style={{ color: deltaColor(part.value) }}>
            {formatDelta(part.value)}
          </span>
        </span>
      ))}
      <span className="text-zh-muted">=</span>
      <span className="font-bold font-mono text-zh-text">{formatDelta(Math.round(sum * 100) / 100)}</span>
      <span className="text-zh-muted">
        {t('page.reports.attribution.real', { defaultValue: '实际' })}
      </span>
      <span className="font-bold font-mono" style={{ color: deltaColor(result.exactDelta) }}>
        {formatDelta(result.exactDelta)}
      </span>
      <span
        className="font-bold"
        style={{ color: ok ? 'rgb(var(--zh-success))' : 'rgb(var(--zh-danger))' }}
      >
        {ok
          ? t('page.reports.attribution.reconciled', { defaultValue: '✓ 已对账' })
          : t('page.reports.attribution.unreconciled', {
              defaultValue: '✗ 归因未闭合（残差 {{residual}} 分），不要据此判断',
              residual: result.residual,
            })}
      </span>
    </div>
  );
}

/**
 * 「口径主导」警示条。
 *
 * 实测真实数据必现：`83.8 → 89.98（+6.2）` 那一次，域贡献全为 0，
 * 6.18 全部来自「参与域从 5 个变成 10 个」—— 分数涨了，但没有任何域变好。
 * 不点明的话，用户会把它当成改进成果。
 */
export function StructureDominatedWarning({ result }: { result: AttributionBreakdown }) {
  const t = useT();
  return (
    <div
      className="mb-3 rounded-md px-3 py-2 text-[11px] leading-relaxed"
      style={{
        background: 'rgb(var(--zh-warning) / 0.08)',
        border: '1px solid rgb(var(--zh-warning) / 0.35)',
        color: 'rgb(var(--zh-text))',
      }}
    >
      {t('page.reports.attribution.structureDominated', {
        defaultValue:
          '本次 {{delta}} 分的变化里有 {{structure}} 分来自参与加权的域数量变化（{{from}} 个 → {{to}} 个），不是任何域真的变好或变差。把它当成改进或退步会得出错误结论。',
        delta: formatDelta(result.actualDelta),
        structure: formatDelta(result.structurePoints),
        from: result.activeStart,
        to: result.activeEnd,
      })}
    </div>
  );
}

/** 区间选择器：标题 + 粒度下拉（区间 / 较上期） */
export function AttributionHeader({
  active,
  options,
  onSelect,
}: {
  active: string;
  options: Array<{ value: string; label: string }>;
  onSelect: (value: string) => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center justify-between mb-3 gap-3">
      <h2 className="text-base font-bold text-zh-text">
        {t('page.reports.attribution.title', { defaultValue: '分数变化归因' })}
      </h2>
      <select
        value={active}
        onChange={(event) => onSelect(event.target.value)}
        className="text-xs rounded-md px-2 py-1.5 bg-zh-panel text-zh-text"
        style={{ border: '1px solid rgb(var(--zh-line))' }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** 汇总行：本期变化 + 拉低 / 拉高结论 —— 用户唯一能直接拿去行动的部分 */
export function AttributionSummary({
  breakdown,
  drops,
  rises,
}: {
  breakdown: AttributionBreakdown;
  drops: AttributionBreakdown['domains'];
  rises: AttributionBreakdown['domains'];
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-3 text-xs">
      <span className="text-zh-muted">
        {t('page.reports.attribution.total', { defaultValue: '本期变化' })}{' '}
        <span
          className="font-bold text-sm"
          style={{ color: deltaColor(breakdown.actualDelta) }}
        >
          {formatDelta(breakdown.actualDelta)}
        </span>
        <span className="text-zh-muted">
          {' '}
          ({breakdown.startScore} → {breakdown.endScore})
        </span>
      </span>
      <span className="inline-flex items-baseline gap-1">
        <span className="text-zh-muted">
          {t('page.reports.attribution.dragDown', { defaultValue: '拉低' })}
        </span>
        <DomainChips
          domains={drops}
          emptyLabel={t('page.reports.attribution.none', { defaultValue: '无' })}
        />
      </span>
      <span className="inline-flex items-baseline gap-1">
        <span className="text-zh-muted">
          {t('page.reports.attribution.dragUp', { defaultValue: '拉高' })}
        </span>
        <DomainChips
          domains={rises}
          emptyLabel={t('page.reports.attribution.none', { defaultValue: '无' })}
        />
      </span>
    </div>
  );
}

/** 脚注：解释「有效权重归一化」口径，防止读者把同样的跌幅算轻 */
export function AttributionNote() {
  const t = useT();
  return (
    <p className="mt-2 text-[11px] text-zh-muted">
      {t('page.reports.attribution.note', {
        defaultValue:
          '贡献总分 = 域内变化 × 有效权重。有效权重按「本次参与加权的域」归一化：只跑了 9 个域时每域约 11.1%，而不是配置里的 10%，所以同样的跌幅会更明显地影响总分。',
      })}
    </p>
  );
}
