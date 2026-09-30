import {
  useMacOSTrafficLightInset,
  TRAFFIC_LIGHT_OFFSET,
} from '../../hooks/useMacOSTrafficLightInset';
import { ShieldLogo } from '../ui/Icons';
import { useT } from '../../i18n';

interface TitleBarProps {
  onOpenSettings: () => void;
  projectName?: string;
  sidebarOpen?: boolean;
}

/** 顶部统一品牌栏 — 360 风格：LOGO+名称居左，项目文件夹居中，侧边栏开关居右 */
export function TitleBar({
  onOpenSettings,
  projectName,
  sidebarOpen,
}: TitleBarProps) {
  const maximized = useMacOSTrafficLightInset();
  const t = useT();

  return (
    <div
      className="relative flex items-center shrink-0"
      style={{
        height: 'var(--zh-header-title-h)',
        background: 'rgb(var(--zh-bg-brand))',
        color: 'rgb(var(--zh-text-on-brand))',
        WebkitAppRegion: 'drag' as const,
      }}
    >
      {/* 左：红绿灯占位 + LOGO + 智汇码盾 */}
      <div className="flex items-center gap-2 pl-0" style={{ WebkitAppRegion: 'drag' }}>
        <div style={{ width: maximized ? 16 : TRAFFIC_LIGHT_OFFSET, flexShrink: 0 }} />
        <ShieldLogo size={18} />
        <span style={{ fontSize: 'var(--zh-font-md)', fontWeight: 600, letterSpacing: 0.5 }}>
          {t('layout.brandName')}
        </span>
      </div>

      {/* 中：项目文件夹（绝对定位，相对窗口中心线真居中，不受左右块宽度影响） */}
      <div
        className="flex items-center justify-center gap-2"
        style={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          maxWidth: '45%',
          overflow: 'hidden',
          WebkitAppRegion: 'drag',
        }}
      >
        {projectName ? (
          <>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0 }}
            >
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            </svg>
            <span
              style={{
                fontSize: 'var(--zh-font-sm)',
                opacity: 0.95,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {projectName}
            </span>
          </>
        ) : (
          <span style={{ fontSize: 'var(--zh-font-sm)', opacity: 0.75, whiteSpace: 'nowrap' }}>
            {t('layout.noProject')}
          </span>
        )}
      </div>

      {/* 右：侧边栏按钮（备份中心已归入下方分类导航栏，不再占顶行）。
          中块 absolute 脱离文档流后，右块需 margin-left:auto 保持在行尾 */}
      <div
        className="flex items-center gap-2 pr-3"
        style={{ WebkitAppRegion: 'no-drag' as const, marginLeft: 'auto' }}
      >
        <button
          onClick={onOpenSettings}
          className="flex items-center justify-center border-none cursor-pointer transition-colors hover:bg-white/20"
          style={{
            width: 28,
            height: 24,
            borderRadius: 'var(--zh-radius-sm)',
            background: 'rgba(255,255,255,0.15)',
            color: 'rgb(var(--zh-text-on-brand))',
          }}
          title={sidebarOpen ? t('layout.collapseSidebar') : t('layout.expandSidebar')}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M15 3v18" />
            {sidebarOpen ? <path d="M8 9l3 3-3 3" /> : <path d="M10 9l-3 3 3 3" />}
          </svg>
        </button>
      </div>
    </div>
  );
}
