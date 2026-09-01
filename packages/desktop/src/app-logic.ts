import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { t } from '@zh/i18n';
import { useToast } from './components/ui/Toast';
import type { ToastVariant } from './components/ui/toast-logic';
import type { AiToolConfigData } from './types/electron';
import {
  installGuardHooks,
  startSentinelMonitoring,
  readGuardConfig,
  writeGuardConfig,
  getSentinelState,
  setSentinelEnabled,
} from './services/engineApi';

export type Page =
  | 'welcome'
  | 'dashboard'
  | 'security'
  | 'deps'
  | 'techdebt'
  | 'secrets'
  | 'garbage'
  | 'performance'
  | 'guard'
  | 'inspect'
  | 'sentinel'
  | 'refactor'
  | 'evolve'
  | 'reports'
  | 'backup'
  | 'scoring'
  | 'profile';

export interface ProjectInfo {
  name: string;
  path: string;
}

export const STORAGE_KEY = 'zh:projects';

export const DEFAULT_AI_TOOL: AiToolConfigData = {
  id: 'opencode',
  name: 'OpenCode',
  enabled: false,
  mode: 'linter',
  configFile: '.opencode/command/zhshield.md',
};

/** AI 工具开关：配置状态 + 保存回调 */
function useAiToolConfig(
  projects: ProjectInfo[],
  toast: (msg: string, variant?: ToastVariant) => void,
): {
  aiTool: AiToolConfigData | null;
  setAiTool: Dispatch<SetStateAction<AiToolConfigData | null>>;
  aiApplying: boolean;
  toggleAiTool: (enabled: boolean) => Promise<void>;
} {
  const [aiTool, setAiTool] = useState<AiToolConfigData | null>(null);
  const [aiApplying, setAiApplying] = useState(false);

  const toggleAiTool = useCallback(
    async (enabled: boolean) => {
      const current = aiTool ?? DEFAULT_AI_TOOL;
      const next = { ...current, enabled };
      setAiTool(next);
      setAiApplying(true);
      try {
        const result = await window.electronAPI?.ai?.saveConfig(
          next,
          projects.map((p) => p.path),
        );
        if (result?.saved) {
          notifyAiToolResult(enabled, result, toast);
        } else {
          toast(t('toast.aiToolSaveFailed'), 'error');
        }
      } catch {
        toast(t('toast.aiToolSaveFailed'), 'error');
        setAiTool({ ...(aiTool ?? DEFAULT_AI_TOOL), enabled: !enabled });
      } finally {
        setAiApplying(false);
      }
    },
    [aiTool, projects, toast],
  );

  return { aiTool, setAiTool, aiApplying, toggleAiTool };
}

/** 门禁总开关：读写 guard-config.json 的 enabled 字段 */
function useLoadGateConfig(
  setGateEnabledState: Dispatch<SetStateAction<boolean | null>>,
  setGateLoading: Dispatch<SetStateAction<boolean>>,
): void {
  useEffect(() => {
    let cancelled = false;
    readGuardConfig()
      .then((config) => {
        if (!cancelled) {
          setGateEnabledState(config.enabled);
          setGateLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGateEnabledState(true);
          setGateLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
}

async function saveGateConfig(
  enabled: boolean,
  setGateEnabledState: Dispatch<SetStateAction<boolean | null>>,
  toast: (msg: string, variant?: ToastVariant) => void,
): Promise<void> {
  try {
    const current = await readGuardConfig();
    await writeGuardConfig({ ...current, enabled });
  } catch {
    setGateEnabledState(!enabled);
    toast(t('toast.guardConfigSaveFailed'), 'error');
  }
}

function useGateSwitch(toast: (msg: string, variant?: ToastVariant) => void): {
  gateEnabled: boolean | null;
  setGateEnabled: (enabled: boolean) => void;
  gateLoading: boolean;
} {
  const [gateEnabled, setGateEnabledState] = useState<boolean | null>(null);
  const [gateLoading, setGateLoading] = useState(true);
  useLoadGateConfig(setGateEnabledState, setGateLoading);
  const setGateEnabled = useCallback(
    async (enabled: boolean) => {
      setGateEnabledState(enabled);
      await saveGateConfig(enabled, setGateEnabledState, toast);
    },
    [toast],
  );
  return { gateEnabled, setGateEnabled, gateLoading };
}

/** 哨兵总开关：读写 sentinel-state.json 的 enabled 字段 */
function useLoadSentinelConfig(
  setSentinelEnabledState: Dispatch<SetStateAction<boolean | null>>,
  setSentinelLoading: Dispatch<SetStateAction<boolean>>,
): void {
  useEffect(() => {
    let cancelled = false;
    getSentinelState()
      .then((state) => {
        if (!cancelled) {
          setSentinelEnabledState(state.enabled);
          setSentinelLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSentinelEnabledState(true);
          setSentinelLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
}

async function saveSentinelConfig(
  enabled: boolean,
  setSentinelEnabledState: Dispatch<SetStateAction<boolean | null>>,
  toast: (msg: string, variant?: ToastVariant) => void,
): Promise<void> {
  try {
    const result = await setSentinelEnabled(enabled);
    if (!result.ok) {
      setSentinelEnabledState(!enabled);
      toast(t('toast.sentinelConfigSaveFailed'), 'error');
    }
  } catch {
    setSentinelEnabledState(!enabled);
    toast(t('toast.sentinelConfigSaveFailed'), 'error');
  }
}

function useSentinelSwitch(toast: (msg: string, variant?: ToastVariant) => void): {
  sentinelEnabled: boolean | null;
  setSentinelEnabledState: (enabled: boolean) => void;
  sentinelLoading: boolean;
} {
  const [sentinelEnabled, setSentinelEnabledState] = useState<boolean | null>(null);
  const [sentinelLoading, setSentinelLoading] = useState(true);
  useLoadSentinelConfig(setSentinelEnabledState, setSentinelLoading);
  const setEnabled = useCallback(
    async (enabled: boolean) => {
      setSentinelEnabledState(enabled);
      await saveSentinelConfig(enabled, setSentinelEnabledState, toast);
    },
    [toast],
  );
  return { sentinelEnabled, setSentinelEnabledState: setEnabled, sentinelLoading };
}

/**
 * 智能引擎总开关：一个开关联动「门禁系统 + 哨兵监控」两侧。
 * 「完全合并」模式——门禁/哨兵不再单独可开关，均由本开关驱动。
 */
function useIntelligentEngineSwitch(
  gate: { gateEnabled: boolean | null; setGateEnabled: (v: boolean) => void; gateLoading: boolean },
  sentinel: {
    sentinelEnabled: boolean | null;
    setSentinelEnabledState: (v: boolean) => void;
    sentinelLoading: boolean;
  },
): {
  intelligentEnabled: boolean;
  setIntelligentEnabled: (enabled: boolean) => void;
  intelligentLoading: boolean;
} {
  const [toggling, setToggling] = useState(false);
  // 未加载完按「开」处理，避免启动时闪烁（与原来各子开关默认常开一致）
  const intelligentEnabled = (gate.gateEnabled ?? true) && (sentinel.sentinelEnabled ?? true);
  const setIntelligentEnabled = useCallback(
    (enabled: boolean) => {
      setToggling(true);
      gate.setGateEnabled(enabled);
      sentinel.setSentinelEnabledState(enabled);
      // 乐观更新后，底层异步落盘；短暂标记加载态保持观感一致
      const timer = setTimeout(setToggling, 120, false);
      return () => clearTimeout(timer);
    },
    [gate, sentinel],
  );
  return {
    intelligentEnabled,
    setIntelligentEnabled,
    intelligentLoading: toggling || gate.gateLoading || sentinel.sentinelLoading,
  };
}

/** 从守护列表移除项目（仅移除列表项，不删除磁盘文件） */
function useRemoveProject(
  projects: ProjectInfo[],
  setProjects: Dispatch<SetStateAction<ProjectInfo[]>>,
  setCurrentPage: Dispatch<SetStateAction<Page>>,
  toast: (msg: string, variant?: ToastVariant) => void,
): { removeProject: (path: string) => void } {
  const removeProject = useCallback(
    (path: string) => {
      const target = projects.find((p) => p.path === path);
      const next = projects.filter((p) => p.path !== path);
      setProjects(next);
      if (next.length === 0) setCurrentPage('welcome');
      toast(t('toast.projectRemoved', { projectName: target?.name ?? '' }), 'info');
    },
    [projects, setProjects, setCurrentPage, toast],
  );

  return { removeProject };
}

/** 打开文件夹选择并添加项目 */
function useAddProject(
  setProjects: Dispatch<SetStateAction<ProjectInfo[]>>,
  setCurrentPage: Dispatch<SetStateAction<Page>>,
  toast: (msg: string, variant?: ToastVariant) => void,
  setOnboardingProject: (name: string | null) => void,
): { openFolderAndAddProject: () => Promise<void> } {
  const openFolderAndAddProject = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.openFolderDialog) {
      toast(t('toast.desktopOnlyFolderPicker'), 'warning');
      return;
    }
    const path = await api.openFolderDialog();
    if (!path) return; // 用户主动取消对话框，保持静默
    const name = path.split('/').pop() || path.split('\\').pop() || '';
    setProjects((prev) => [...prev, { name, path }]);
    setOnboardingProject(name);
    toast(t('toast.projectAdded', { projectName: name }), 'success');
    void installGuardHooks(path).catch(() => {});
    void startSentinelMonitoring(path).catch(() => {});
  }, [toast, setProjects, setCurrentPage, setOnboardingProject]);

  return { openFolderAndAddProject };
}

function useCurrentProjectIndex(projectCount: number): {
  currentProjectIndex: number;
  switchCurrentProject: (index: number) => void;
} {
  const [currentProjectIndex, setCurrentProjectIndex] = useState(0);
  useEffect(() => {
    setCurrentProjectIndex((idx) => Math.min(idx, Math.max(projectCount - 1, 0)));
  }, [projectCount]);
  const switchCurrentProject = useCallback((index: number) => {
    setCurrentProjectIndex(index);
  }, []);
  return { currentProjectIndex, switchCurrentProject };
}

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
  const { openFolderAndAddProject } = useAddProject(
    setProjects,
    setCurrentPage,
    toast,
    setOnboardingProject,
  );
  const { removeProject } = useRemoveProject(projects, setProjects, setCurrentPage, toast);
  const { currentProjectIndex, switchCurrentProject } = useCurrentProjectIndex(projects.length);

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
    currentProjectIndex,
    switchCurrentProject,
  };
}

function useLoadInitialState(handlers: {
  setProjects: (projects: ProjectInfo[]) => void;
  setCurrentPage: (page: Page) => void;
  setLoaded: (loaded: boolean) => void;
  setAiTool: (tool: AiToolConfigData | null) => void;
}): void {
  const { setProjects, setCurrentPage, setLoaded, setAiTool } = handlers;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const saved = await loadProjectsFromStorage();
      if (!cancelled) {
        if (saved && saved.length > 0) {
          setProjects(saved);
          setCurrentPage('dashboard');
        }
        setLoaded(true);
      }
    }
    load();

    let cancelledAi = false;
    window.electronAPI?.ai
      ?.loadConfig()
      .then((cfg) => {
        if (!cancelledAi) setAiTool(cfg);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      cancelledAi = true;
    };
  }, [setProjects, setCurrentPage, setLoaded, setAiTool]);
}

function usePersistProjects(projects: ProjectInfo[], loaded: boolean): void {
  const saving = useRef(false);

  useEffect(() => {
    if (!loaded || saving.current) return;
    saving.current = true;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
      window.electronAPI?.saveProjects?.(projects).catch(() => {});
    } finally {
      saving.current = false;
    }
  }, [projects, loaded]);
}

async function loadProjectsFromStorage(): Promise<ProjectInfo[] | null> {
  let saved: ProjectInfo[] | null = null;
  try {
    const fromIpc = await window.electronAPI?.loadProjects?.();
    if (fromIpc && fromIpc.length > 0) saved = fromIpc;
  } catch {
    /* ipc not available */
  }

  if (!saved || saved.length === 0) {
    saved = loadFromLocalStorage();
  }
  return saved;
}

function loadFromLocalStorage(): ProjectInfo[] | null {
  try {
    const fromLs = localStorage.getItem(STORAGE_KEY);
    if (!fromLs) return null;
    const parsed: ProjectInfo[] = JSON.parse(fromLs);
    return parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function notifyAiToolResult(
  enabled: boolean,
  result: { projects: Array<{ ok: boolean }>; saved: boolean },
  toast: (msg: string, variant?: ToastVariant) => void,
): void {
  if (!enabled) {
    toast(t('toast.aiToolDisabled'), 'info');
    return;
  }
  if (result.projects.length === 0) {
    toast(t('toast.aiToolEnabledNoProjects'), 'info');
    return;
  }
  const okCount = result.projects.filter((p) => p.ok).length;
  toast(
    t('toast.aiToolEnabledWritten', { written: okCount, total: result.projects.length }),
    okCount === result.projects.length ? 'success' : 'warning',
  );
}
