/**
 * 安全中心的视图标签栏。
 *
 * 从 `security-report-parts.tsx` 拆出：报告视图文件已接近 400 行代码阈值，
 * 标签栏是自包含的展示件，拆出后不改变渲染位置与交互。
 */

/**
 * 四个视图：三个检测分类 + 合规基线（跨分类的只读标准映射）。
 *
 * 合规基线不“跟在密钥管理后面”，而是与三类并列的第四个视图：它覆盖 14 条
 * ASVS 条款，密钥只占其中两条，放成密钥的附属会误导归属。
 */
export type SecurityTab = 'vuln' | 'malware' | 'secrets' | 'compliance';

export type Translate = (key: string, params?: Record<string, unknown>) => string;

/** 视图标签：顺序即界面顺序（漏洞 / 恶意代码 / 密钥 / 合规基线） */
const TABS: Array<{ id: SecurityTab; labelKey: string; defaultLabel: string }> = [
  { id: 'vuln', labelKey: 'page.security.tab.vuln', defaultLabel: '漏洞扫描' },
  { id: 'malware', labelKey: 'page.security.tab.malware', defaultLabel: '病毒查杀' },
  { id: 'secrets', labelKey: 'page.security.tab.secrets', defaultLabel: '密钥管理' },
  { id: 'compliance', labelKey: 'page.security.tab.compliance', defaultLabel: '合规基线' },
];

/** 分类切换标签栏 */
export function SecurityTabBar({
  tab,
  onTabChange,
  t,
}: {
  tab: SecurityTab;
  onTabChange: (tab: SecurityTab) => void;
  t: Translate;
}) {
  return (
    <div className="flex gap-2">
      {TABS.map((t2) => (
        <button
          key={t2.id}
          onClick={() => onTabChange(t2.id)}
          className={`px-4 py-2 rounded-lg text-sm font-medium border-none cursor-pointer transition-colors ${
            tab === t2.id
              ? 'bg-brand-600 text-white'
              : 'bg-zh-panel text-zh-ink-2 hover:bg-zh-line'
          }`}
        >
          {t(t2.labelKey, { defaultValue: t2.defaultLabel })}
        </button>
      ))}
    </div>
  );
}
