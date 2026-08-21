import { Bounce } from './Bounce';
import { useT } from '../../i18n';

interface CopyAllToAiButtonProps {
  onClick: () => void;
  /** 按钮文字，默认「全部复制到 AI」 */
  label?: string;
  /** 追加类名（如 ml-auto 布局调整） */
  className?: string;
}

/**
 * 全局统一的「全部复制到 AI」按钮：所有检查结果页一键复制全部问题的唯一样式
 * （智靛浅底圆角胶囊）。改这一处，巡检/门禁/安全/性能/哨兵/重构全部生效。
 */
export function CopyAllToAiButton({ onClick, label, className }: CopyAllToAiButtonProps) {
  const t = useT();
  return (
    <Bounce
      as="button"
      onClick={onClick}
      className={`px-4 py-1.5 rounded-full text-xs font-semibold text-blue-800 bg-blue-50 hover:bg-blue-100 border-none cursor-pointer shrink-0${className ? ` ${className}` : ''}`}
    >
      {label ?? t('common.copyAllToAi')}
    </Bounce>
  );
}
