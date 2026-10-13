import { useT } from '../../i18n';
import { CopyToAiBaseButton } from './CopyToAiBaseButton';

interface CopyToAiButtonProps {
  onClick: () => void;
  className?: string;
}

export function CopyToAiButton({ onClick, className }: CopyToAiButtonProps) {
  const t = useT();
  return (
    <CopyToAiBaseButton onClick={onClick} className={className} shape="pill">
      {t('common.copyToAi')}
    </CopyToAiBaseButton>
  );
}
