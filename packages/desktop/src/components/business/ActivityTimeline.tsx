interface Activity {
  id: string;
  time: string;
  text: string;
  type: 'success' | 'warning' | 'info' | 'error';
}

interface ActivityTimelineProps {
  activities: Activity[];
}

export function ActivityTimeline({ activities }: ActivityTimelineProps) {
  const typeColors = {
    success: 'bg-success-700',
    warning: 'bg-warning-500',
    info: 'bg-info-500',
    error: 'bg-danger-500',
  };

  return (
    <div className="space-y-3">
      {activities.map((activity) => (
        <div key={activity.id} className="flex items-start gap-3">
          <div className="mt-1.5">
            <div className={`w-2 h-2 rounded-full ${typeColors[activity.type]}`}></div>
          </div>
          <div className="flex-1">
            <div className="text-sm text-zh-muted">{activity.time}</div>
            <div className="text-sm">{activity.text}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
