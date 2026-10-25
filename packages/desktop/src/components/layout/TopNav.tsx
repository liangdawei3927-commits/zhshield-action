import { NavIcon } from '../ui/Icons';
import { TitleBar } from './title-bar';
import { Bounce } from '../ui/Bounce';
import { useT } from '../../i18n';
import { navItems, type NavItem } from './nav-items';

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
 * 第二行：薄荷绿分类导航 banner（360 风格：顶部大图标、底部文字）。
 *
 * 十项**等距平铺**：2026-10-25 移除了「常驻守护」段前的分组竖线 —— 那条线本身占
 * 1px + 左右各 8px 外边距，使末尾两项（哨兵、备份）与前八项分到的横向空间不一致，
 * 十宫格看起来不齐。分组的语义仍在 `nav-items.ts` 的 `group` 字段里（排序与
 * 报告中心评分卡片行仍按它分段），只是不再画视觉分隔。
 */
function CategoryNav({ currentPage, onNavigate }: Pick<TopNavProps, 'currentPage' | 'onNavigate'>) {
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
      {navItems.map((item) => (
        <CategoryNavItem
          key={item.id}
          item={item}
          active={currentPage === item.id}
          onNavigate={onNavigate}
        />
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
