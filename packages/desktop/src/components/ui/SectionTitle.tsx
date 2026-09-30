import type { ReactNode } from 'react';

/**
 * 结果卡分区标题行：图标底板 + 标题 + 可选右侧插槽。
 *
 * 依赖管家 / 技术债 / 密钥三页此前各内联一份逐字相同的实现，结构与样式在此收敛；
 * `right` 为空时不渲染右侧容器，DOM 输出与原实现一致。
 */
export function SectionTitle({
  icon,
  label,
  right,
}: {
  icon: ReactNode;
  label: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <span className="w-6 h-6 rounded-md bg-brand-50 text-brand-700 flex items-center justify-center shrink-0">
        {icon}
      </span>
      <span className="text-sm font-semibold text-zh-ink-2">{label}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}
