import { useT } from '../i18n';
import { ResultCard } from '../components/ui/ResultCard';
import type { ProjectGateItemData, ProjectGateReportData } from '../types/electron';

/**
 * 报告中心「门禁结论」区块。
 *
 * 为什么需要这一块：健康分/覆盖率门禁的判定发生在**扫描之后**（聚合值那时才存在），
 * 规则引擎那边对这三条只留一句「由门禁阶段判定」的跳过说明。如果没有这个面板，
 * 用户看到的是「规则被跳过」，永远看不到「到底过没过」—— 判定做了但没人看见，
 * 等于没做（形态⑤：产出了却没人渲染）。
 *
 * 四条硬约束（都来自上游契约，别在这里重新解释）：
 * ① `total === 0` 是「没有门禁规则」，不是「全部达标」，必须说清楚；
 * ② `undetermined` 不算通过，单独一色；
 * ③ 非阻断条目（`blocking === false`）即使失败也标注「不阻断」，否则用户会以为
 *    这次体检被拦住了；
 * ④ **结论标题必须三态**：「未达标」与「未判定」是两回事，不能共用一句红色
 *    「门禁未通过」。依据见下方 `resolveVerdict`。
 */

const STATUS_STYLE: Record<
  ProjectGateItemData['status'],
  { mark: string; color: string }
> = {
  passed: { mark: '✓', color: 'rgb(var(--zh-success))' },
  failed: { mark: '✗', color: 'rgb(var(--zh-danger))' },
  undetermined: { mark: '–', color: 'rgb(var(--zh-warning))' },
};

function GateRow({ item }: { item: ProjectGateItemData }) {
  const style = STATUS_STYLE[item.status];
  return (
    <li className="flex items-start gap-2 px-4 py-2.5 text-xs leading-relaxed">
      <span aria-hidden className="mt-[1px] font-semibold" style={{ color: style.color }}>
        {style.mark}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-zh-ink">{item.ruleId}</span>
          {!item.blocking && (
            <span
              className="rounded px-1.5 py-[1px] text-[10px]"
              style={{
                background: 'rgb(var(--zh-warning) / 0.12)',
                color: 'rgb(var(--zh-warning))',
              }}
            >
              不阻断
            </span>
          )}
        </div>
        <div className="text-zh-muted">{item.message}</div>
      </div>
    </li>
  );
}

function GateSummary({ gates }: { gates: ProjectGateReportData }) {
  const t = useT();
  const parts = [
    t('page.reports.gates.passed', { defaultValue: '通过 {{n}}', n: gates.passed }),
    t('page.reports.gates.failed', { defaultValue: '未达标 {{n}}', n: gates.failed }),
    t('page.reports.gates.undetermined', {
      defaultValue: '未判定 {{n}}',
      n: gates.undetermined,
    }),
  ];
  return <span className="text-[11px] text-zh-muted">{parts.join(' · ')}</span>;
}

/** 无门禁规则时的空态：说清「没规则」而不是让用户以为全绿 */
function EmptyGates() {
  const t = useT();
  return (
    <div className="px-4 py-3 text-xs text-zh-muted">
      {t('page.reports.gates.empty', {
        defaultValue:
          '当前没有生效的后置门禁规则。健康分 / 覆盖率门禁由云端规则下发（guard.block.official.*），未同步时此处为空——这不代表门禁全部通过。',
      })}
    </div>
  );
}

/**
 * 结论三态 —— 为什么不能只看 `ok`。
 *
 * `ok` 的定义是「阻断型门禁全部判定完成且无一越界」（`post-scan-gate.ts`），它把
 * **未判定**和**未达标**都收进 `false`。CI 需要这个严格口径（缺数就不该放行），
 * 但渲染层照抄会让「缺数据源」被画成「代码越界」：实测桌面端健康分 85（阈值 70，
 * 达标）而覆盖率报告缺失时，本区块照样显示红色「门禁未通过」—— 用户看到的结论
 * 与实际判定相反，红灯也就变成了噪音。
 *
 * 上游 CLI 出口（`sop-banner.ts` 的 `reportPostScanGates`）对同一份数据的口径是：
 * 未判定**不升格为失败**，只打印「缺数据源，不算通过」。渲染层与它对齐：
 *   · 阻断型有越界         → 未达标（红）
 *   · 无越界但存在未判定   → 未判定（警示，文案写明不等于通过）
 *   · 其余                 → 通过（绿）
 */
function resolveVerdict(gates: ProjectGateReportData): 'failed' | 'undetermined' | 'passed' {
  // 阻断型越界与否由 `blockingFailed` 定（非阻断条目失败不拉红，见硬约束③）；
  // 未判定单独一档，不并入失败。
  if ((gates.blockingFailed ?? 0) > 0) return 'failed';
  if ((gates.undetermined ?? 0) > 0) return 'undetermined';
  return 'passed';
}

export function ProjectGatesSection({ gates }: { gates?: ProjectGateReportData }) {
  const t = useT();
  const hasRules = (gates?.total ?? 0) > 0;
  const verdict = hasRules ? resolveVerdict(gates!) : 'none';
  const stateColor =
    verdict === 'none'
      ? 'rgb(var(--zh-muted))'
      : verdict === 'failed'
        ? 'rgb(var(--zh-danger))'
        : verdict === 'undetermined'
          ? 'rgb(var(--zh-warning))'
          : 'rgb(var(--zh-success))';
  const headline =
    verdict === 'none'
      ? t('page.reports.gates.none', { defaultValue: '无门禁' })
      : verdict === 'failed'
        ? t('page.reports.gates.blocked', { defaultValue: '门禁未通过' })
        : verdict === 'undetermined'
          ? t('page.reports.gates.incomplete', { defaultValue: '门禁未判定' })
          : t('page.reports.gates.ok', { defaultValue: '门禁通过' });

  return (
    <section className="mt-4">
      <div className="mb-2 flex items-baseline gap-3">
        <h3 className="text-sm font-medium text-zh-ink">
          {t('page.reports.gates.title', { defaultValue: '门禁结论' })}
        </h3>
        <span className="text-xs font-medium" style={{ color: stateColor }}>
          {headline}
        </span>
        {hasRules && <GateSummary gates={gates!} />}
      </div>
      {verdict === 'undetermined' && (
        <p className="mb-2 text-[11px] leading-relaxed text-zh-muted">
          {t('page.reports.gates.incompleteHint', {
            defaultValue:
              '未判定 = 缺数据源（如缺少行级覆盖率报告），既不算通过也不算未达标；补齐数据源后此处会自动给出结论。',
          })}
        </p>
      )}
      <ResultCard variant="list" className="overflow-hidden">
        {hasRules ? (
          <ul className="divide-y divide-zh-line/40">
            {gates!.items.map((item) => (
              <GateRow key={item.ruleId} item={item} />
            ))}
          </ul>
        ) : (
          <EmptyGates />
        )}
      </ResultCard>
    </section>
  );
}
