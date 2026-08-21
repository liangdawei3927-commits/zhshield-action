export interface AppNotification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export interface NotificationStore {
  notifications: AppNotification[];
  unreadCount: number;
}

export type NotificationListener = (notification: AppNotification) => void;