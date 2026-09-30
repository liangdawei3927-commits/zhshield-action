/**
 * 严重级别徽章（底色 + 文字色由调用方按 severity 配置注入）
 *
 * 巡检（performance-parts 的 IssueCard）、安全（security-parts 的 FindingCard /
 * MalwareCard）三张结果卡此前各内联一份逐字相同的徽章 span，只有文案与配色来源
 * 不同，故把 span 外壳收敛到此处；DOM 输出与原实现一致。
 */
export function SeverityBadge({
  bg,
  color,
  label,
}: {
  /** 徽章底色（如 SEVERITY_CONFIG[severity].bg） */
  bg: string;
  /** 徽章文字色（如 SEVERITY_CONFIG[severity].color） */
  color: string;
  /** 徽章文案（已翻译） */
  label: string;
}) {
  return (
    <span className="px-2 py-0.5 rounded text-xs font-medium" style={{ background: bg, color }}>
      {label}
    </span>
  );
}
