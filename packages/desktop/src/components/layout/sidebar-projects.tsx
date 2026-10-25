/**
 * 侧边栏「项目管理」区块：项目行、行内动作（画像 / 报告 / 移除）与添加项目入口。
 *
 * 从 `sidebar-interactive.tsx` 按职责拆出（原文件超 400 行代码阈值）；
 * 对外导出仍从 `sidebar-interactive` 统一暴露，调用方无需改动。
 */

import type { ReactNode } from 'react';
import { SectionTitle } from './sidebar-common';
import { Bounce } from '../ui/Bounce';
import { useT } from '../../i18n';

export interface ProjectInfo {
  name: string;
  path: string;
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
  // 报告中心：必须先切项目再跳转，否则 ReportsPage 会拿旧 projectPath 显示错项目数据
  const openProjectReports = () => {
    onSwitchProject(index);
    onNavigate('reports');
    onClose();
  };
  return (
    <Bounce
      as="div"
      className={`relative w-full flex items-center gap-1 rounded-lg transition-colors hover:bg-zh-panel ${isActive ? 'bg-zh-panel/50' : ''}`}
    >
      {/* 当前项目竖条：选中项跨重启保持后，需要一眼能认出来是哪一个 */}
      {isActive && (
        <span
          aria-hidden
          className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-zh-brand"
        />
      )}
      <button
        onClick={() => {
          onSwitchProject(index);
          onNavigate('inspect');
          onClose();
        }}
        aria-current={isActive ? 'true' : undefined}
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
      <ProjectRowActions
        project={project}
        index={index}
        onClose={onClose}
        onRequestDelete={onRequestDelete}
        onOpenProjectProfile={onOpenProjectProfile}
        onOpenProjectReports={openProjectReports}
        t={t}
      />
    </Bounce>
  );
}

/** 行内动作按钮的公共外观：三枚按钮只差图标、危险色与是否右留白 */
function RowActionButton({
  onClick,
  label,
  title,
  danger,
  children,
}: {
  onClick: () => void;
  label: string;
  title?: string;
  danger?: boolean;
  children: ReactNode;
}) {
  const tone = danger
    ? 'hover:text-danger-500 hover:bg-danger-50'
    : 'hover:text-zh-ink-2 hover:bg-zh-panel';
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={title}
      className={`${danger ? 'shrink-0 mr-2' : 'shrink-0'} flex items-center justify-center w-7 h-7 rounded-md border-none cursor-pointer text-zh-muted ${tone} transition-colors`}
    >
      {children}
    </button>
  );
}

/** 项目画像（人像）图标 */
function ProfileGlyph() {
  return (
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
  );
}

/** 报告中心（文档）图标 */
function ReportsGlyph() {
  return (
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
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6M8 13h8M8 17h5" />
    </svg>
  );
}

/** 删除项目（垃圾桶）图标 */
function TrashGlyph() {
  return (
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
  );
}

function ProjectRowActions({
  project,
  index,
  onClose,
  onRequestDelete,
  onOpenProjectProfile,
  onOpenProjectReports,
  t,
}: {
  project: ProjectInfo;
  index: number;
  onClose: () => void;
  onRequestDelete: (p: ProjectInfo) => void;
  onOpenProjectProfile: (project: ProjectInfo, index: number) => void;
  onOpenProjectReports: () => void;
  t: ReturnType<typeof useT>;
}) {
  return (
    <>
      <RowActionButton
        onClick={() => {
          onOpenProjectProfile(project, index);
          onClose();
        }}
        label={t('layout.profile')}
      >
        <ProfileGlyph />
      </RowActionButton>
      <RowActionButton
        onClick={onOpenProjectReports}
        label={t('nav.reports')}
        title={t('nav.reports')}
      >
        <ReportsGlyph />
      </RowActionButton>
      <RowActionButton
        onClick={() => onRequestDelete(project)}
        label={t('layout.deleteProject', { name: project.name })}
        danger
      >
        <TrashGlyph />
      </RowActionButton>
    </>
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
        <AddProjectButton
          onAddProject={onAddProject}
          onClose={onClose}
          t={t}
        />
      </div>
    </section>
  );
}

function AddProjectButton({
  onAddProject,
  onClose,
  t,
}: {
  onAddProject: () => void;
  onClose: () => void;
  t: ReturnType<typeof useT>;
}) {
  return (
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
  );
}
