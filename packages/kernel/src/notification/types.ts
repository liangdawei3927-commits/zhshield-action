/**
 * 应用通知：由 kernel 产生、经宿主推送给用户。
 * action 可选，提供时携带按钮文案与点击回调。
 */
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

/** 通知存储快照：全部通知列表与未读计数，供 UI 直接渲染 */
export interface NotificationStore {
  notifications: AppNotification[];
  unreadCount: number;
}

/** 通知监听器：订阅新到通知的回调 */
export type NotificationListener = (notification: AppNotification) => void;
