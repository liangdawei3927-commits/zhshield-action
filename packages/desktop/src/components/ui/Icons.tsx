import type { ReactNode } from 'react';

// 盾牌Logo：白色线条盾牌 + 代码箭头 <-（品牌唯一 LOGO）
export function ShieldLogo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* 盾牌外框 */}
      <path
        d="M12 2L3 6.5V12C3 17.25 6.84 22.09 12 23.5C17.16 22.09 21 17.25 21 12V6.5L12 2Z"
        stroke="white"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="none"
      />
      {/* <- 箭头符号 */}
      {/* < 符号 */}
      <path
        d="M8 10L5.5 12.5L8 15"
        stroke="white"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* - 符号（与<底边齐平，增加间距） */}
      <line
        x1="12"
        y1="15"
        x2="17"
        y2="15"
        stroke="white"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 分类图标内容（24×24，极简 stroke 风格，功能语义清晰） */
const NAV_ICON_CONTENT: Record<string, ReactNode> = {
  // 项目体检：速度表
  dashboard: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 13l3-3" />
      <path d="M6 7l2 2" />
      <path d="M18 7l-2 2" />
    </>
  ),
  // 智能巡检：扫描文档
  inspect: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M3 12h18" />
      <path d="M6 16h5" />
      <circle cx="17" cy="16" r="1.5" />
    </>
  ),
  // 门禁检查：挂锁
  guard: (
    <>
      <rect x="6" y="11" width="12" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
      <circle cx="12" cy="16" r="1.5" />
    </>
  ),
  // 哨兵监控：雷达
  sentinel: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 4v3" />
      <path d="M12 17v3" />
      <path d="M4 12h3" />
      <path d="M17 12h3" />
    </>
  ),
  // 安全扫描：盾牌
  security: (
    <>
      <path d="M12 2L4 6v5.5c0 4.5 3.5 8.5 8 10.5 4.5-2 8-6 8-10.5V6l-8-4z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  // 依赖管家：依赖图谱（节点 + 边）
  deps: (
    <>
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="18" r="2" />
      <circle cx="19" cy="18" r="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 7v3M10 12H7M14 12h3M7 16.5l1.5-1.5M17 16.5l-1.5-1.5" />
    </>
  ),
  // 垃圾清理：垃圾桶
  garbage: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  // 性能优化：闪电
  performance: (
    <>
      <path d="M13 2L4 14h8l-1 8 9-12h-8l1-8z" />
    </>
  ),
  // 技术债仪表盘：债务仪表
  techdebt: (
    <>
      <path d="M4 19A8 8 0 0 1 20 19" />
      <path d="M12 13V8" />
      <circle cx="12" cy="6" r="1.5" />
      <path d="M4 19h16" />
    </>
  ),
  // 密钥全生命周期：钥匙
  secrets: (
    <>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M11 12L21 2" />
      <path d="M15.5 7.5l3 3L22 7l-3-3" />
    </>
  ),
  // 代码重构：与底部功能地图同款
  refactor: (
    <>
      <path d="M4 12l4-4-4-4" />
      <path d="M20 12l-4 4 4 4" />
      <path d="M14 4h-2a5 5 0 00-5 5v2" />
      <path d="M10 20h2a5 5 0 005-5v-2" />
    </>
  ),
  // 备份中心：历史快照（时钟 + 回滚箭头，对应本地快照与恢复能力）
  backup: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 00-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 4" />
    </>
  ),
  // 打开备份文件夹：文件夹
  folder: (
    <>
      <path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V6z" />
    </>
  ),
  // 报告中心：文档
  reports: (
    <>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8M8 17h5" />
    </>
  ),
  // 规则进化：上升箭头/进化
  evolve: (
    <>
      <path d="M12 20V4" />
      <path d="M5 11l7-7 7 7" />
      <path d="M6 16h12" />
    </>
  ),
  // 项目画像：指纹/识别
  profile: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </>
  ),
};

/** 分类图标（24×24，极简 stroke 风格） */
export function NavIcon({ id, size = 24 }: { id: string; size?: number }) {
  const content = NAV_ICON_CONTENT[id];
  if (!content) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {content}
    </svg>
  );
}
