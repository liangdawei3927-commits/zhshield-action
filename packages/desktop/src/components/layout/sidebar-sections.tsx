/**
 * 侧边栏「区块级」组件：标题栏、AI 工具开关、规则进化入口。
 *
 * 从 `sidebar-interactive.tsx` 按职责拆出（原文件超 400 行代码阈值）；
 * 对外导出仍从 `sidebar-interactive` 统一暴露，调用方无需改动。
 */

import { SectionTitle } from './sidebar-common';
import { ShieldLogo, NavIcon } from '../ui/Icons';
import type { AiToolConfigData } from '../../types/electron';
import { BounceCard } from '../ui/Bounce';
import { useT } from '../../i18n';

export function SidebarHeader({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <div
      className="flex items-center justify-between px-5 border-b border-zh-line shrink-0"
      style={{ height: 56 }}
    >
      <div className="flex items-center gap-2">
        <ShieldLogo size={18} />
        <span className="text-sm font-semibold text-zh-ink">{t('layout.sidebarTitle')}</span>
      </div>
      <button
        onClick={onClose}
        className="flex items-center justify-center w-7 h-7 rounded-md hover:bg-zh-panel border-none cursor-pointer text-zh-muted hover:text-zh-ink-2 transition-colors"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// ⛔ AI 工具暂下线（见 src/feature-flags.ts：FEATURE_AI_TOOL_ENABLED=false）。
// 功能未闭环——每次仍需用户手动搬运给外部 AI 编程工具，开关不能真正驱动完整 AI 流程。
// 切勿自行改回 Sidebar 直接渲染；恢复需用户明确指示并同步文档/e2e。
export function AiToolSection({
  aiTool,
  aiApplying,
  onToggleAiTool,
}: {
  aiTool: AiToolConfigData | null;
  aiApplying: boolean;
  onToggleAiTool: (enabled: boolean) => void;
}) {
  const t = useT();
  return (
    <section>
      <SectionTitle
        label={t('layout.aiTool')}
        icon={
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="2" y="4" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 18v3" />
          </svg>
        }
      />
      <BounceCard className="rounded-xl bg-zh-panel/60 p-3">
        <div className="flex items-center gap-2.5">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-zh-ink">OpenCode</div>
            <div className="text-xs text-zh-muted mt-0.5">{t('layout.aiToolDesc')}</div>
          </div>
          <button
            onClick={() => onToggleAiTool(!(aiTool?.enabled ?? false))}
            disabled={aiApplying}
            aria-label={t('layout.aiToolToggle')}
            className={`shrink-0 w-9 h-5 rounded-full p-0.5 transition-colors border cursor-pointer ${
              aiApplying ? 'opacity-50 cursor-wait' : ''
            } ${aiTool?.enabled ? 'bg-success-700 border-success-700' : 'bg-zh-ink-2/20 border-zh-ink-2/30'}`}
          >
            <span
              className={`block w-4 h-4 rounded-full shadow-sm transition-transform ${
                aiTool?.enabled ? 'bg-white translate-x-4' : 'bg-zh-ink-2/60 translate-x-0'
              }`}
            />
          </button>
        </div>
        {aiTool?.enabled && (
          <div className="mt-2 text-xs leading-relaxed text-zh-success-fg">
            {t('layout.aiToolEnabled')}
          </div>
        )}
      </BounceCard>
    </section>
  );
}

// ⛔ 规则进化暂下线（见 src/feature-flags.ts：FEATURE_EVOLVE_ENABLED=false）。
// 自动进化标准需足够规模真实用户认可（基础用户 <1000 不可启动，单人判断不能成标准）。
// 切勿自行改回 Sidebar 直接渲染；恢复需用户明确指示并同步文档/e2e。
export function EvolveSection({
  currentPage,
  onNavigate,
  onClose,
}: {
  currentPage: string;
  onNavigate: (page: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <section>
      <SectionTitle
        label={t('layout.evolve')}
        icon={<NavIcon id="evolve" size={12} />}
      />
      <BounceCard className="rounded-xl bg-zh-panel/60 p-1.5">
        <button
          type="button"
          onClick={() => {
            onNavigate('evolve');
            onClose();
          }}
          aria-label={t('layout.evolve')}
          className={`w-full flex items-center gap-2.5 rounded-lg py-1.5 pl-2 pr-1.5 text-left border-none cursor-pointer transition-colors ${
            currentPage === 'evolve' ? 'bg-zh-panel/60' : 'hover:bg-zh-panel/60'
          }`}
        >
          <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-info-50 text-info-600 shrink-0">
            <NavIcon id="evolve" size={14} />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-xs font-medium text-zh-ink">{t('layout.evolve')}</span>
            <span className="block text-xs text-zh-muted mt-0.5">{t('layout.evolveDesc')}</span>
          </span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-zh-muted"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
      </BounceCard>
    </section>
  );
}
