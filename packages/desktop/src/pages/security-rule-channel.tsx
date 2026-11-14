/**
 * 安全页「规则通道」横幅与账本分类（security-rule-channel.tsx）
 *
 * 从 `security-report-parts.tsx` 拆出：那里已越过 400 行阈值（zhcheck
 * 的 oversized-file），而规则通道横幅是一块自洽的展示单元——它只依赖
 * 报告里的 `ruleChannel` / `ruleLedger`，与统计卡、分类面板没有耦合。
 *
 * 职责边界：「规则没能评估」≠「工具不可用」。前者是本文件（规则通道未执行 /
 * 规则降级 / 按项目前提跳过），后者是页面里的工具级降级横幅。混在一起会让
 * 用户按「重装工具」去修一个其实是规则或项目前提的问题。
 */

import type { SecurityScanReportData } from '../types/electron';
import type { Translate } from './security-tab-bar';

/** 账本条目类型（从报告类型派生，避免第二份形状定义） */
export type RuleLedgerEntry = NonNullable<SecurityScanReportData['ruleLedger']>[number];

/**
 * 把账本分成页面上的两个桶：未能评估 / 按项目前提跳过。
 *
 * 纯函数：判定规则只有一处，渲染层不再各自 filter（否则两处口径迟早分叉）。
 */
export function classifyRuleLedger(ledger: readonly RuleLedgerEntry[]): {
  failed: RuleLedgerEntry[];
  skipped: RuleLedgerEntry[];
} {
  const failed = ledger.filter((entry) => entry.status === 'error' || entry.degraded === true);
  const skipped = ledger.filter((entry) => entry.status === 'skipped' && entry.degraded !== true);
  return { failed, skipped };
}

/** 逐条规则明细列表（两个桶共用；颜色与测试标记由调用方给） */
export function RuleLedgerList({
  entries,
  tone,
  testId,
}: {
  entries: readonly RuleLedgerEntry[];
  tone: string;
  testId: string;
}) {
  if (entries.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-1">
      {entries.map((entry, index) => (
        <li
          key={`${entry.ruleId}-${index}`}
          className={`text-xs ${tone} break-all`}
          data-testid={testId}
        >
          <span className="font-medium">{entry.ruleId}</span>
          {entry.reason ? ` — ${entry.reason}` : ''}
        </li>
      ))}
    </ul>
  );
}

/** 通道未执行：danger 条（只跑启发式时 0 检出 ≠ 干净） */
function ChannelNotRunNotice({ t }: { t: Translate }) {
  return (
    <div className="px-4 py-3 rounded-xl bg-danger-50 border border-danger-100">
      <div className="text-xs text-danger-700">
        {t('page.security.result.ruleChannelNotRun', {
          defaultValue:
            '规则通道本次未执行：只跑了启发式通道，0 检出不代表代码干净。请查看扫描日志确认规则集是否加载失败。',
        })}
      </div>
    </div>
  );
}

/** 未能评估：warning 条 + 逐条原因（默认折叠，旧报告无明细时明确标注，不冒充完整） */
function DegradedRulesNotice({
  count,
  entries,
  t,
}: {
  count: number;
  entries: readonly RuleLedgerEntry[];
  t: Translate;
}) {
  return (
    <details className="px-4 py-2 rounded-xl bg-warning-50 border border-warning-100">
      <summary className="cursor-pointer text-xs font-medium text-warning-700">
        {t('page.security.result.ruleChannelDegradedSummary', {
          defaultValue: '{{count}} 条规则未能评估——未检测不等于通过。',
          count,
        })}
      </summary>
      <div className="mt-1 text-[11px] text-warning-600">
        {t('page.security.result.ruleChannelDegradedHint', {
          defaultValue: '逐条原因见下，可据此判断是缺工具、缺适配器，还是规则本身跑不成。',
        })}
      </div>
      {entries.length > 0 ? (
        <RuleLedgerList entries={entries} tone="text-warning-600" testId="security-rule-degraded" />
      ) : (
        <div className="mt-1 text-xs text-warning-500">
          {t('page.security.result.ruleChannelNoLedger', {
            defaultValue: '逐条明细未知（该报告由旧版本产出）。',
          })}
        </div>
      )}
    </details>
  );
}

/** 按项目前提跳过：中性条、默认折叠（既定裁剪 ≠ 故障，重装工具对它无效） */
function SkippedRulesNotice({
  count,
  entries,
  t,
}: {
  count: number;
  entries: readonly RuleLedgerEntry[];
  t: Translate;
}) {
  return (
    <details className="px-4 py-2 rounded-xl bg-info-50 border border-info-100">
      <summary className="text-xs text-info-700 cursor-pointer">
        {t('page.security.result.ruleChannelSkipped', {
          defaultValue: '{{count}} 条规则按项目前提跳过（本项目不适用，不是故障）。',
          count,
        })}
      </summary>
      <RuleLedgerList entries={entries} tone="text-info-500" testId="security-rule-skipped" />
    </details>
  );
}

/**
 * 规则通道求值账横幅：有规则没评估成 → 0 检出 ≠ 干净。
 *
 * 与工具级降级横幅分开：这里是「规则没能评估」（规则通道未执行 / 规则降级），
 * 不是工具不可用。混在一起会让用户按「重装工具」去修一个其实是规则/项目前提的问题。
 */
export function SecurityRuleChannelBanner({
  report,
  t,
}: {
  report: SecurityScanReportData;
  /**
   * 翻译函数由调用方注入（不在此内部调 `useT()`）：本组件以
   * `renderToStaticMarkup` 直接渲染做快照断言，无 i18n Provider 时
   * 内部取 hook 会抛错。保持纯展示、翻译外置。
   */
  t: Translate;
}) {
  const translate = t;
  const channel = report.ruleChannel;
  const ledger = report.ruleLedger ?? [];
  const hasLedger = ledger.length > 0;
  const { failed, skipped } = classifyRuleLedger(ledger);
  const degradedCount = hasLedger ? failed.length : (channel?.degraded ?? 0);
  const skippedCount = hasLedger ? skipped.length : (channel?.skipped ?? 0);
  if (!channel && !hasLedger) return null;
  if (channel?.ran !== false && degradedCount === 0 && skippedCount === 0) return null;

  return (
    <div className="mb-3 space-y-1.5">
      {channel?.ran === false ? <ChannelNotRunNotice t={translate} /> : null}
      {degradedCount > 0 ? (
        <DegradedRulesNotice count={degradedCount} entries={failed} t={translate} />
      ) : null}
      {skippedCount > 0 ? (
        <SkippedRulesNotice count={skippedCount} entries={skipped} t={translate} />
      ) : null}
    </div>
  );
}
