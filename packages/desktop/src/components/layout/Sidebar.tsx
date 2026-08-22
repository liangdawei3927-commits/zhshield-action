import { useState } from 'react';
import type { AiToolConfigData } from '../../types/electron';
import { SidebarHeader, ProjectsSection, AiToolSection } from './sidebar-interactive';
import { ThemeSection, LanguageSection, AboutSection } from './sidebar-about';
import { EngineStatusSection } from './sidebar-status';
import type { ProjectInfo } from './sidebar-interactive';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useT } from '../../i18n';

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  projects: ProjectInfo[];
  currentProjectIndex: number;
  onSwitchProject: (index: number) => void;
  currentPage: string;
  onNavigate: (page: string) => void;
  onAddProject: () => void;
  onRemoveProject: (path: string) => void;
  aiTool: AiToolConfigData | null;
  aiApplying: boolean;
  onToggleAiTool: (enabled: boolean) => void;
}

export function Sidebar({ open, onClose, projects, currentProjectIndex, onSwitchProject, currentPage: _currentPage, onNavigate, onAddProject, onRemoveProject, aiTool, aiApplying, onToggleAiTool }: SidebarProps) {
  const t = useT();
  const [pendingDelete, setPendingDelete] = useState<ProjectInfo | null>(null);

  return (
    <>
      {/* 遮罩 */}
      {open && (
        <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      )}

      {/* 面板 — 从右侧滑入 */}
      <aside
        className="fixed top-0 right-0 z-50 h-full bg-zh-card shadow-2xl flex flex-col transition-transform duration-300 ease-out"
        style={{
          width: 280,
          transform: open ? 'translateX(0)' : 'translateX(100%)',
        }}
      >
        <SidebarHeader onClose={onClose} />

        {/* 内容 — key 绑定 open：每次打开时重挂载，重播卡片入场弹跳 */}
        <div key={open ? 'sidebar-open' : 'sidebar-closed'} className="flex-1 overflow-y-auto px-4 py-5 space-y-8">
          <ProjectsSection projects={projects} currentProjectIndex={currentProjectIndex} onSwitchProject={onSwitchProject} onNavigate={onNavigate} onClose={onClose} onAddProject={onAddProject} onRequestDelete={setPendingDelete} />
          <EngineStatusSection />
          <AiToolSection aiTool={aiTool} aiApplying={aiApplying} onToggleAiTool={onToggleAiTool} />
          <ThemeSection />
          <LanguageSection />
          <AboutSection />
        </div>
      </aside>

      {/* 确认弹窗必须渲染在 aside 之外：aside 带 transform，会作为 fixed 后代的包含块，导致遮罩只盖住侧边栏 */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('layout.removeProjectTitle')}
        message={
          pendingDelete && (
            <>
              {t('layout.removeProjectMessage1', { name: pendingDelete.name })}
              <br />
              {t('layout.removeProjectMessage2')}
            </>
          )
        }
        confirmLabel={t('common.remove')}
        variant="danger"
        onConfirm={() => {
          if (pendingDelete) onRemoveProject(pendingDelete.path);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
