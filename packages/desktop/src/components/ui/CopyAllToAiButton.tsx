import { useT } from '../../i18n';
import { CopyToAiBaseButton } from './CopyToAiBaseButton';

interface CopyAllToAiButtonProps {
  onClick: () => void;
  label?: string;
  className?: string;
}

export function CopyAllToAiButton({ onClick, label, className }: CopyAllToAiButtonProps) {
  const t = useT();
  return (
    <CopyToAiBaseButton onClick={onClick} className={className} shape="capsule">
      {label ?? t('common.copyAllToAi')}
    </CopyToAiBaseButton>
  );
}
