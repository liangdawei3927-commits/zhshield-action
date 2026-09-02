import type { ReactNode } from 'react';
import { ShieldLogo } from '../ui/Icons';
import type { AiToolConfigData } from '../../types/electron';
import { Bounce, BounceCard } from '../ui/Bounce';
import { useT } from '../../i18n';

export interface ProjectInfo {
  name: string;
  path: string;
}

export function SectionTitle({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <h3 className="text-[10px] font-semibold text-zh-muted uppercase tracking-wider mb-3 flex items-center gap-1.5">
      {icon}
      {label}
    </h3>
  );
}

function ProjectRow({
  project,
  index,
  isActive,
  onNavigate,
  onClose,
  onRequestDelete,
  onSwitchProject,
  onOpenProjectProfile,
}: {
  project: ProjectInfo;
  index: number;
  isActive: boolean;
  onNavigate: (page: string) => void;
  onClose: () => void;
  onRequestDelete: (p: ProjectInfo) => void;
  onSwitchProject: (index: number) => void;
  onOpenProjectProfile: (project: ProjectInfo, index: number) => void;
}) {
  const t = useT();
  return (
    <Bounce
      as="div"
      className={`w-full flex items-center gap-1 rounded-lg transition-colors hover:bg-zh-panel ${isActive ? 'bg-zh-panel/50' : ''}`}
    >
      <button
        onClick={() => {
          onSwitchProject(index);
          onNavigate('dashboard');
          onClose();
        }}
        className="flex-1 min-w-0 flex items-center gap-2.5 pl-3 pr-1 py-2 rounded-lg text-left border-none cursor-pointer bg-transparent"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`shrink-0 ${isActive ? 'text-zh-brand' : 'text-zh-muted'}`}
        >
          <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <span
          className={`text-xs truncate ${isActive ? 'text-zh-ink font-medium' : 'text-zh-ink-2'}`}
        >
          {project.name}
        </span>
      </button>
      <button
        onClick={() => {
          onOpenProjectProfile(project, index);
          onClose();
        }}
        aria-label={t('layout.profile')}
        className="shrink-0 flex items-center justify-center w-7 h-7 rounded-md border-none cursor-pointer text-zh-muted hover:text-zh-ink-2 hover:bg-zh-panel transition-colors"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      </button>
      <button
        onClick={() => onRequestDelete(project)}
        aria-label={t('layout.deleteProject', { name: project.name })}
        className="shrink-0 mr-2 flex items-center justify-center w-7 h-7 rounded-md border-none cursor-pointer text-zh-muted hover:text-danger-500 hover:bg-danger-50 transition-colors"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          <path d="M10 11v6M14 11v6" />
        </svg>
      </button>
    </Bounce>
  );
}

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

export function ProjectsSection({
  projects,
  currentProjectIndex,
  onSwitchProject,
  onNavigate,
  onClose,
  onAddProject,
  onRequestDelete,
  onOpenProjectProfile,
}: {
  projects: ProjectInfo[];
  currentProjectIndex: number;
  onSwitchProject: (index: number) => void;
  onNavigate: (page: string) => void;
  onClose: () => void;
  onAddProject: () => void;
  onRequestDelete: (p: ProjectInfo) => void;
  onOpenProjectProfile: (project: ProjectInfo, index: number) => void;
}) {
  const t = useT();
  return (
    <section>
      <SectionTitle
        label={t('layout.projectManagement')}
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
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        }
      />
      <div className="space-y-1">
        {projects.length === 0 ? (
          <div className="text-xs text-zh-muted py-2 text-center">{t('layout.noProjects')}</div>
        ) : (
          projects.map((p, i) => (
            <ProjectRow
              key={p.path}
              project={p}
              index={i}
              isActive={i === currentProjectIndex}
              onSwitchProject={onSwitchProject}
              onNavigate={onNavigate}
              onClose={onClose}
              onRequestDelete={onRequestDelete}
              onOpenProjectProfile={onOpenProjectProfile}
            />
          ))
        )}
        <Bounce
          as="button"
          onClick={() => {
            onAddProject();
            onClose();
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left border-none cursor-pointer transition-colors hover:bg-success-50 text-success-800"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span className="text-xs font-medium">{t('layout.addProject')}</span>
        </Bounce>
      </div>
    </section>
  );
}

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
            <div className="text-[11px] text-zh-muted mt-0.5">{t('layout.aiToolDesc')}</div>
          </div>
          <button
            onClick={() => onToggleAiTool(!(aiTool?.enabled ?? false))}
            disabled={aiApplying}
            aria-label={t('layout.aiToolToggle')}
            className={`shrink-0 w-9 h-5 rounded-full p-0.5 transition-colors border-none cursor-pointer ${
              aiApplying ? 'opacity-50 cursor-wait' : ''
            } ${aiTool?.enabled ? 'bg-success-700' : 'bg-zh-line'}`}
          >
            <span
              className={`block w-4 h-4 bg-white rounded-full shadow transition-transform ${
                aiTool?.enabled ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
        {aiTool?.enabled && (
          <div className="mt-2 text-[11px] leading-relaxed text-zh-success-fg">
            {t('layout.aiToolEnabled')}
          </div>
        )}
      </BounceCard>
    </section>
  );
}
