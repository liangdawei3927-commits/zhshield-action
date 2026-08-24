import type { ReactNode } from 'react';

// 方块机器人Logo：白色线条方块 + 白色笑脸 < -（品牌唯一 LOGO）
export function ShieldLogo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" stroke="white" strokeWidth="1.8"/>
      {/* 左眼 < 开眼，开口小一点更像代码符号 */}
      <path d="M10.5 9.5L7.5 12L10.5 14.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      {/* 右眼 - 眯眼 */}
      <line x1="14" y1="12" x2="17.5" y2="12" stroke="white" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

/** 分类图标内容（24×24，极简 stroke 风格，功能语义清晰） */
const NAV_ICON_CONTENT: Record<string, ReactNode> = {
  dashboard: ( // 项目体检：速度表
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 13l3-3" />
      <path d="M6 7l2 2" />
      <path d="M18 7l-2 2" />
    </>
  ),
  inspect: ( // 智能巡检：扫描文档
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M3 12h18" />
      <path d="M6 16h5" />
      <circle cx="17" cy="16" r="1.5" />
    </>
  ),
  guard: ( // 门禁检查：挂锁
    <>
      <rect x="6" y="11" width="12" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
      <circle cx="12" cy="16" r="1.5" />
    </>
  ),
  sentinel: ( // 哨兵监控：雷达
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 4v3" />
      <path d="M12 17v3" />
      <path d="M4 12h3" />
      <path d="M17 12h3" />
    </>
  ),
  security: ( // 安全扫描：盾牌
    <>
      <path d="M12 2L4 6v5.5c0 4.5 3.5 8.5 8 10.5 4.5-2 8-6 8-10.5V6l-8-4z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  deps: ( // 依赖管家：依赖图谱（节点 + 边）
    <>
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="18" r="2" />
      <circle cx="19" cy="18" r="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 7v3M10 12H7M14 12h3M7 16.5l1.5-1.5M17 16.5l-1.5-1.5" />
    </>
  ),
  garbage: ( // 垃圾清理：垃圾桶
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  performance: ( // 性能优化：闪电
    <>
      <path d="M13 2L4 14h8l-1 8 9-12h-8l1-8z" />
    </>
  ),
  techdebt: ( // 技术债仪表盘：债务仪表
    <>
      <path d="M4 19A8 8 0 0 1 20 19" />
      <path d="M12 13V8" />
      <circle cx="12" cy="6" r="1.5" />
      <path d="M4 19h16" />
    </>
  ),
  secrets: ( // 密钥全生命周期：钥匙
    <>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M11 12L21 2" />
      <path d="M15.5 7.5l3 3L22 7l-3-3" />
    </>
  ),
  refactor: ( // 代码重构：与底部功能地图同款
    <>
      <path d="M4 12l4-4-4-4" />
      <path d="M20 12l-4 4 4 4" />
      <path d="M14 4h-2a5 5 0 00-5 5v2" />
      <path d="M10 20h2a5 5 0 005-5v-2" />
    </>
  ),
  backup: ( // 备份中心：云下载
    <>
      <path d="M18 16a4 4 0 000-8 5 5 0 00-9-2 5 5 0 00-9 2 4 4 0 000 8" />
      <path d="M12 12v7" />
      <path d="M9 16l3 3 3-3" />
    </>
  ),
  folder: ( // 打开备份文件夹：文件夹
    <>
      <path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V6z" />
    </>
  ),
  reports: ( // 报告中心：文档
    <>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8M8 17h5" />
    </>
  ),
  evolve: ( // 规则进化：上升箭头/进化
    <>
      <path d="M12 20V4" />
      <path d="M5 11l7-7 7 7" />
      <path d="M6 16h12" />
    </>
  ),
  profile: ( // 项目画像：指纹/识别
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
