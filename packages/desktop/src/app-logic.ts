/**
 * 应用级状态装配：把「开关族 / 项目族」两个子模块的结果合成 `App` 需要的形状。
 *
 * 拆分（原文件超 400 行代码阈值，按职责切两刀）：
 * - `app-logic-switches.ts`：AI 工具配置、门禁总开关、智能引擎总开关
 * - `app-logic-projects.ts`：选中项目持久化与自愈、增删项目、列表读写盘、诊断引导态
 * - `app-logic-types.ts`：三处共享的页面 / 项目类型与常量
 *
 * 对外接口不变：`useAppState`、页面类型与存储键仍从本模块导出。
 */

import { useState } from 'react';
import { useToast } from './components/ui/Toast';
import { useSentinelSwitch } from './app-logic-sentinel';
import { useAiToolConfig, useGateSwitch, useIntelligentEngineSwitch } from './app-logic-switches';
import {
  useAddProject,
  useLoadInitialState,
  useOnboardedProjects,
  usePersistProjects,
  useRemoveProject,
  useSelectedProject,
} from './app-logic-projects';
import type { Page, ProjectInfo } from './app-logic-types';

export type { Page, ProjectInfo } from './app-logic-types';
export { STORAGE_KEY, ONBOARDED_KEY, DEFAULT_AI_TOOL } from './app-logic-types';

export function useAppState() {
  const [currentPage, setCurrentPage] = useState<Page>('welcome');
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const { toast } = useToast();
  const { aiTool, setAiTool, aiApplying, toggleAiTool } = useAiToolConfig(projects, toast);
  const { gateEnabled, setGateEnabled, gateLoading } = useGateSwitch(toast);
  const { sentinelEnabled, setSentinelEnabledState, sentinelLoading } = useSentinelSwitch(toast);
  const { intelligentEnabled, setIntelligentEnabled, intelligentLoading } =
    useIntelligentEngineSwitch(
      { gateEnabled, setGateEnabled, gateLoading },
      { sentinelEnabled, setSentinelEnabledState, sentinelLoading },
    );
  useLoadInitialState({ setProjects, setCurrentPage, setLoaded, setAiTool });
  usePersistProjects(projects, loaded);
  const [onboardingProject, setOnboardingProject] = useState<string | null>(null);
  const { onboardedPaths, markOnboarded } = useOnboardedProjects();
  const { currentProjectIndex, switchCurrentProject, selectProjectByPath } =
    useSelectedProject(projects);
  const { openFolderAndAddProject } = useAddProject({
    setProjects,
    setCurrentPage,
    toast,
    setOnboardingProject,
    selectProjectByPath,
  });
  const { removeProject } = useRemoveProject(projects, setProjects, setCurrentPage, toast);

  return {
    currentPage,
    setCurrentPage,
    projects,
    sidebarOpen,
    setSidebarOpen,
    loaded,
    aiTool,
    aiApplying,
    openFolderAndAddProject,
    removeProject,
    toggleAiTool,
    intelligentEnabled,
    setIntelligentEnabled,
    intelligentLoading,
    onboardingProject,
    setOnboardingProject,
    onboardedPaths,
    markOnboarded,
    currentProjectIndex,
    switchCurrentProject,
  };
}
