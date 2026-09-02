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

/** 侧边栏导航区：直达各功能页（当前含「性能」） */
function NavSection({
  currentPage,
  onNavigate,
  onClose,
}: {
  currentPage: string;
  onNavigate: (page: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const items = [
    {
      id: 'performance',
      label: t('nav.performance'),
      icon: (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      ),
    },
  ];
  return (
    <section>
      <h3 className="text-[10px] font-semibold text-zh-muted uppercase tracking-wider mb-3 flex items-center gap-1.5">
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
          <path d="M3 12h4l3-9 4 18 3-9h4" />
        </svg>
        {t('layout.navigation')}
      </h3>
      <div className="space-y-1">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => {
              onNavigate(item.id);
              onClose();
            }}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left border-none cursor-pointer transition-colors ${
              currentPage === item.id
                ? 'bg-zh-panel/50 text-zh-brand'
                : 'text-zh-ink-2 hover:bg-zh-panel'
            }`}
          >
            <span className="shrink-0">{item.icon}</span>
            <span className="text-xs font-medium">{item.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
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
        <NavSection currentPage={currentPage} onNavigate={onNavigate} onClose={onClose} />
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
