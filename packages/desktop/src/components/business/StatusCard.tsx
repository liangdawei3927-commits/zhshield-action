import { BounceCard } from '../ui/Bounce';

interface StatusCardProps {
  title: string;
  value: string;
  icon: string;
  status: 'success' | 'warning' | 'error';
  onClick?: () => void;
}

export function StatusCard({ title, value, icon, status, onClick }: StatusCardProps) {
  const statusColors = {
    success: 'text-green-700',
    warning: 'text-amber-500',
    error: 'text-red-500',
  };

  return (
    <BounceCard
      as="button"
      onClick={onClick}
      className="bg-zh-card rounded-xl p-4 text-left hover:bg-zh-panel transition-colors w-full shadow-sm"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-zh-muted text-xs">{title}</span>
        <span className="text-lg">{icon}</span>
      </div>
      <div className={`text-xl font-bold ${statusColors[status]}`}>{value}</div>
    </BounceCard>
  );
}
