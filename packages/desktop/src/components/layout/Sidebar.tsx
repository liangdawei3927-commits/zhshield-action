import { useState } from 'react';
import type { AiToolConfigData } from '../../types/electron';
import { SidebarHeader, ProjectsSection, AiToolSection } from './sidebar-interactive';
import { ThemeSection, LanguageSection, AboutSection } from './sidebar-about';
import { EngineStatusSection, WisdomBrainCard, type EngineCardProps } from './sidebar-status';
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
  onOpenProjectProfile: (project: ProjectInfo, index: number) => void;
  aiTool: AiToolConfigData | null;
  aiApplying: boolean;
  onToggleAiTool: (enabled: boolean) => void;
  intelligentEnabled: boolean;
  setIntelligentEnabled: (enabled: boolean) => void;
  intelligentLoading: boolean;
}

function SidebarOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} /> : null;
}

function SidebarPanel({
  open,
  onClose,
  projects,
  currentProjectIndex,
  onSwitchProject,
  onNavigate,
  onAddProject,
  onRequestDelete,
  aiTool,
  aiApplying,
  onToggleAiTool,
  intelligentEnabled,
  setIntelligentEnabled,
  intelligentLoading,
  currentPage,
  onOpenProjectProfile,
}: {
  open: boolean;
  onClose: () => void;
  projects: ProjectInfo[];
  currentProjectIndex: number;
  onSwitchProject: (index: number) => void;
  onNavigate: (page: string) => void;
  onAddProject: () => void;
  onRequestDelete: (project: ProjectInfo) => void;
  aiTool: AiToolConfigData | null;
  aiApplying: boolean;
  onToggleAiTool: (enabled: boolean) => void;
  currentPage: string;
  onOpenProjectProfile: (project: ProjectInfo, index: number) => void;
} & EngineCardProps) {
  return (
    <aside
      className="fixed top-0 right-0 z-50 h-full bg-zh-card shadow-2xl flex flex-col transition-transform duration-300 ease-out"
      style={{
        width: 280,
        transform: open ? 'translateX(0)' : 'translateX(100%)',
      }}
    >
      <SidebarHeader onClose={onClose} />

      <div
        key={open ? 'sidebar-open' : 'sidebar-closed'}
        className="flex-1 overflow-y-auto px-4 py-5 space-y-8"
      >
        <ProjectsSection
          projects={projects}
          currentProjectIndex={currentProjectIndex}
          onSwitchProject={onSwitchProject}
          onNavigate={onNavigate}
          onClose={onClose}
          onAddProject={onAddProject}
          onRequestDelete={onRequestDelete}
          onOpenProjectProfile={onOpenProjectProfile}
        />
        <WisdomBrainCard />
        <EngineStatusSection
          intelligentEnabled={intelligentEnabled}
          setIntelligentEnabled={setIntelligentEnabled}
          intelligentLoading={intelligentLoading}
        />
        <AiToolSection aiTool={aiTool} aiApplying={aiApplying} onToggleAiTool={onToggleAiTool} />
        <ThemeSection />
        <LanguageSection />
        <AboutSection />
      </div>
    </aside>
  );
}

function SidebarDeleteDialog({
  pendingDelete,
  onRemoveProject,
  onClose,
}: {
  pendingDelete: ProjectInfo | null;
  onRemoveProject: (path: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
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
        onClose();
      }}
      onCancel={onClose}
    />
  );
}

export function Sidebar({
  open,
  onClose,
  projects,
  currentProjectIndex,
  onSwitchProject,
  currentPage,
  onNavigate,
  onAddProject,
  onRemoveProject,
  onOpenProjectProfile,
  aiTool,
  aiApplying,
  onToggleAiTool,
  intelligentEnabled,
  setIntelligentEnabled,
  intelligentLoading,
}: SidebarProps) {
  const [pendingDelete, setPendingDelete] = useState<ProjectInfo | null>(null);

  return (
    <>
      <SidebarOverlay open={open} onClose={onClose} />
      <SidebarPanel
        open={open}
        onClose={onClose}
        projects={projects}
        currentProjectIndex={currentProjectIndex}
        onSwitchProject={onSwitchProject}
        onNavigate={onNavigate}
        onAddProject={onAddProject}
        onRequestDelete={setPendingDelete}
        onOpenProjectProfile={onOpenProjectProfile}
        aiTool={aiTool}
        aiApplying={aiApplying}
        onToggleAiTool={onToggleAiTool}
        intelligentEnabled={intelligentEnabled}
        setIntelligentEnabled={setIntelligentEnabled}
        intelligentLoading={intelligentLoading}
        currentPage={currentPage}
      />
      {/* 确认弹窗必须渲染在 aside 之外：aside 带 transform，会作为 fixed 后代的包含块，导致遮罩只盖住侧边栏 */}
      <SidebarDeleteDialog
        pendingDelete={pendingDelete}
        onRemoveProject={onRemoveProject}
        onClose={() => setPendingDelete(null)}
      />
    </>
  );
}
