import type { ComplianceControlResult, ComplianceReport, ComplianceState } from '../compliance/baseline';

/** 状态徽章样式：各态语义必须分得开，未覆盖/缺证据/不适用绝不用“通过”的颜色 */
const STATE_STYLE: Record<ComplianceState, { label: string; color: string; bg: string }> = {
  pass: { label: '通过', color: 'rgb(var(--zh-success))', bg: 'rgb(var(--zh-success) / 0.12)' },
  fail: { label: '失败', color: 'rgb(var(--zh-danger))', bg: 'rgb(var(--zh-danger) / 0.12)' },
  'no-evidence': {
    label: '缺证据',
    color: 'rgb(var(--zh-warning))',
    bg: 'rgb(var(--zh-warning) / 0.12)',
  },
  'not-applicable': {
    label: '不适用',
    color: 'rgb(var(--zh-muted))',
    bg: 'rgb(var(--zh-muted) / 0.08)',
  },
  uncovered: {
    label: '未覆盖',
    color: 'rgb(var(--zh-muted))',
    bg: 'rgb(var(--zh-muted) / 0.1)',
  },
};

/** 单条条款：状态徽章 + 条款号 + 判定依据 */
function ComplianceRow({ control }: { control: ComplianceControlResult }) {
  const style = STATE_STYLE[control.state];
  return (
    <li className="flex items-start gap-3">
      <span
        className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium"
        style={{ background: style.bg, color: style.color }}
      >
        {style.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-zh-ink-2">
          <span className="mr-2 text-zh-muted">{control.clause}</span>
          {control.title}
        </div>
        <div className="mt-0.5 text-[11px] text-zh-muted">
          {control.source} · {control.detail}
        </div>
      </div>
    </li>
  );
}

/**
 * 安全中心详情页的「合规基线」区（只读）。
 *
 * 它把各域已落盘结论按标准条款汇总成五态：通过 / 失败 / 缺证据 / 不适用 / 未覆盖。
 * 「不适用」表达规则确实没有可检对象（如无 Web 框架时的安全响应头），与「通过」分开。
 * 刻意不做评分、不做“合规率百分比”——未覆盖条款混进分母会让数字看起来
 * 像“覆盖率还行”，而事实是那几项根本没检查（C4：未检测 ≠ 通过）。
 */
/** 合规卡头部：标题/说明 + 覆盖率摘要（拆出以降低主组件 JSX 嵌套） */
function ComplianceHeader({
  report,
  covered,
  attention,
}: {
  report: ComplianceReport;
  covered: number;
  attention: number;
}) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-zh-ink-2">
          合规基线 · {report.standard.name} {report.standard.version}
        </h3>
        <p className="mt-1 text-xs text-zh-muted">
          只读映射：证据来自各域已落盘的结论，本页不新增扫描；未覆盖、缺证据与不适用都不计为通过。
          <span className="ml-1 text-zh-muted/70">（展开查看逐条）</span>
        </p>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-xs text-zh-muted">有证据覆盖</div>
        <div className="text-sm font-medium text-zh-ink-2">
          {covered} / {report.summary.total}
        </div>
        {attention > 0 ? (
          <div className="mt-0.5 text-[11px] text-warning-600">需关注 {attention} 条</div>
        ) : null}
      </div>
    </header>
  );
}

export function ComplianceBaselineSection({ report }: { report: ComplianceReport }) {
  const covered = report.summary.pass + report.summary.fail;
  const attention =
    report.summary.fail + report.summary.noEvidence;
  return (
    <details
      className="mt-6 rounded-xl bg-zh-card shadow-sm"
      data-testid="compliance-baseline"
    >
      <summary className="cursor-pointer list-none px-5 py-4">
        <ComplianceHeader report={report} covered={covered} attention={attention} />
      </summary>

      <ul className="flex flex-col gap-2 px-5 pb-4">
        {report.controls.map((control) => (
          <ComplianceRow key={control.id} control={control} />
        ))}
      </ul>
    </details>
  );
}
