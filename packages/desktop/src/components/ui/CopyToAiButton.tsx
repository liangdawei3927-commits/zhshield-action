import { Bounce } from './Bounce';
import { useT } from '../../i18n';

interface CopyToAiButtonProps {
  onClick: () => void;
  /** 追加类名（如 ml-auto 布局调整） */
  className?: string;
}

/**
 * 全局统一的「复制到AI」小按钮：所有检查结果页单条问题复制按钮的唯一样式
 * （智靛浅底 11px 小号按钮）。改这一处，巡检/门禁/安全/性能/哨兵/重构全部生效。
 */
export function CopyToAiButton({ onClick, className }: CopyToAiButtonProps) {
  const t = useT();
  return (
    <Bounce
      as="button"
      onClick={onClick}
      className={`px-2 py-0.5 rounded text-[11px] font-medium text-info-800 bg-info-50 hover:bg-info-100 border-none cursor-pointer shrink-0${className ? ` ${className}` : ''}`}
    >
      {t('common.copyToAi')}
    </Bounce>
  );
}
