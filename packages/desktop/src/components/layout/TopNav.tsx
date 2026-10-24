import { Fragment } from 'react';
import { NavIcon } from '../ui/Icons';
import { TitleBar } from './title-bar';
import { Bounce } from '../ui/Bounce';
import { useT } from '../../i18n';
import { navGroupSegments, type NavItem } from './nav-items';

interface TopNavProps {
  currentPage: string;
  onNavigate: (page: string) => void;
  onOpenSettings: () => void;
  projectName?: string;
  sidebarOpen?: boolean;
}

interface CategoryNavItemProps {
  item: NavItem;
  active: boolean;
  onNavigate: (page: string) => void;
}

/** 单个分类导航项：弹跳按钮 + 大图标 + 底部文字 */
function CategoryNavItem({ item, active, onNavigate }: CategoryNavItemProps) {
  const t = useT();
  return (
    <Bounce
      as="button"
      onClick={() => onNavigate(item.id)}
      className="flex items-center justify-center border-none cursor-pointer"
      style={{
        flex: '0 1 auto',
        minWidth: 0,
        height: '100%',
      }}
    >
      {/* 内容块：格子均分整行，悬停/选中同为「圆角+底部连页面」色块，仅透明度不同 */}
      <span className={`zh-nav-block ${active ? 'zh-nav-block--active' : ''}`}>
        <span className="flex items-center justify-center" style={{ width: 30, height: 30 }}>
          <NavIcon id={item.id} size={28} />
        </span>
        <span style={{ fontSize: 13, fontWeight: active ? 600 : 500, whiteSpace: 'nowrap' }}>
          {item.label ?? t(item.labelKey)}
        </span>
      </span>
    </Bounce>
  );
}

/**
 * 组间分隔线：一条竖线 + 两侧留白。
 *
 * 只画线不写组名 —— 导航行高（图标 30 + 文字 13）塞不下第二行标签，10 项平铺也
 * 挤不出横向空间；组名退到 hover 提示（title）里，语义仍可达。
 */
function GroupDivider({ label }: { label: string }) {
  return (
    <span
      aria-hidden
      data-testid="nav-group-divider"
      title={label}
      className="shrink-0 self-center"
      style={{ width: 1, height: 22, margin: '0 8px', background: 'rgba(255,255,255,0.45)' }}
    />
  );
}

/** 第二行：薄荷绿分类导航 banner（360 风格：顶部大图标、底部文字） */
function CategoryNav({ currentPage, onNavigate }: Pick<TopNavProps, 'currentPage' | 'onNavigate'>) {
  const t = useT();
  // 按性质分段渲染：按需检查在前、常驻守护在后，两组之间一条竖线
  // defaultValue 兜底：dev 下 Vite 只监听 desktop root，语言包新键不会热更新
  const groupLabel = (group: string) =>
    t(`nav.group.${group}`, {
      defaultValue: group === 'daemon' ? '常驻守护' : '按需检查',
    });
  return (
    <nav
      className="flex items-center shrink-0 select-none"
      style={{
        height: 'var(--zh-header-nav-h)',
        background: 'rgb(var(--zh-bg-brand))',
        justifyContent: 'space-around',
        WebkitAppRegion: 'no-drag' as const,
      }}
    >
      {navGroupSegments().map((segment, index) => (
        <Fragment key={segment.group}>
          {index > 0 && <GroupDivider label={groupLabel(segment.group)} />}
          {segment.items.map((item) => (
            <CategoryNavItem
              key={item.id}
              item={item}
              active={currentPage === item.id}
              onNavigate={onNavigate}
            />
          ))}
        </Fragment>
      ))}
    </nav>
  );
}

export function TopNav({
  currentPage,
  onNavigate,
  onOpenSettings,
  projectName,
  sidebarOpen,
}: TopNavProps) {
  return (
    <header className="shrink-0 select-none">
      {/* 第一行：统一品牌色 title bar */}
      <TitleBar
        onOpenSettings={onOpenSettings}
        projectName={projectName}
        sidebarOpen={sidebarOpen}
      />
      {/* 第二行：大图标分类导航 */}
      <CategoryNav currentPage={currentPage} onNavigate={onNavigate} />
    </header>
  );
}
