import { Bounce } from './Bounce';

export interface CopyToAiBaseButtonProps {
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
  shape?: 'pill' | 'capsule';
}

export function CopyToAiBaseButton({ onClick, className, children, shape = 'pill' }: CopyToAiBaseButtonProps) {
  const shapeClass = shape === 'capsule' ? 'rounded-full px-4 py-1.5 text-xs font-semibold' : 'px-2 py-0.5 rounded text-[11px] font-medium';
  return (
    <Bounce
      as="button"
      onClick={onClick}
      className={`${shapeClass} text-info-800 bg-info-50 hover:bg-info-100 border-none cursor-pointer shrink-0${className ? ` ${className}` : ''}`}
    >
      {children}
    </Bounce>
  );
}
