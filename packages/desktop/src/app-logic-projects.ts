/**
 * `app-logic` 的项目族 hook：选中项持久化与自愈、增删项目、项目列表读写盘、诊断引导态。
 *
 * 从 `app-logic.ts` 按职责拆出（原文件超 400 行代码阈值）；
 * 公共类型 / 常量在 `app-logic-types.ts`。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { t } from '@zh/i18n';
import type { AiToolConfigData } from './types/electron';
import { installGuardHooks, startSentinelMonitoring } from './services/engineApi';
import type { ToastVariant } from './components/ui/toast-logic';
import {
  ONBOARDED_KEY,
  STORAGE_KEY,
  type Page,
  type ProjectInfo,
} from './app-logic-types';
import {
  readSelectedProjectPath,
  resolveCanonicalPath,
  resolveSelectedIndex,
  writeSelectedProjectPath,
} from './project-selection';

/** 从守护列表移除项目（仅移除列表项，不删除磁盘文件） */
export function useRemoveProject(
  projects: ProjectInfo[],
  setProjects: Dispatch<SetStateAction<ProjectInfo[]>>,
  setCurrentPage: Dispatch<SetStateAction<Page>>,
  toast: (msg: string, variant?: ToastVariant) => void,
): { removeProject: (path: string) => void } {
  const removeProject = useCallback(
    (path: string) => {
      const target = projects.find((p) => p.path === path);
      const next = projects.filter((p) => p.path !== path);
      // 清理链（画像/DB/内存/云端）fire-and-forget：失败不阻塞 UI——渲染链与清理链解耦；
      // projects.json 落盘由 usePersistProjects 的 saveProjects 机制自动完成，不重复写盘
      void window.electronAPI?.removeProject?.(path).catch(() => {});
      setProjects(next);
      if (next.length === 0) setCurrentPage('welcome');
      toast(t('toast.projectRemoved', { projectName: target?.name ?? '' }), 'info');
    },
    [projects, setProjects, setCurrentPage, toast],
  );

  return { removeProject };
}

/** 添加项目所依赖的应用级能力（状态写入口 + 提示 + 引导态 + 选中项切换） */
export interface AddProjectDeps {
  /** 追加项目到守护列表 */
  setProjects: Dispatch<SetStateAction<ProjectInfo[]>>;
  /**
   * 切页（既有契约保留，当前实现**不读取**）。
   *
   * 添加项目后并不切页：`App` 只在 `projects.length === 0` 时才把 welcome 当落地页，
   * 项目一旦入列表就按 `currentPage` 渲染，无需在此改页。保留字段是为了不改本函数
   * 的对外形状（调用方照旧传入），后续若要在这里切页不必再改签名。
   */
  setCurrentPage: Dispatch<SetStateAction<Page>>;
  /** 轻提示 */
  toast: (msg: string, variant?: ToastVariant) => void;
  /** 标记「刚添加的项目」以触发添加后诊断引导 */
  setOnboardingProject: (name: string | null) => void;
  /** 新添加的项目即成为当前项目 */
  selectProjectByPath: (path: string | null) => void;
}

/** 打开文件夹选择并添加项目 */
export function useAddProject(deps: AddProjectDeps): {
  openFolderAndAddProject: () => Promise<void>;
} {
  const { setProjects, toast, setOnboardingProject, selectProjectByPath } = deps;
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
    // 新添加的项目即成为当前项目：否则引导完成后「项目体检」跑的仍是旧项目
    selectProjectByPath(path);
    setOnboardingProject(name);
    toast(t('toast.projectAdded', { projectName: name }), 'success');
    void installGuardHooks(path).catch(() => {});
    void startSentinelMonitoring(path).catch(() => {});
  }, [toast, setProjects, setOnboardingProject, selectProjectByPath]);

  return { openFolderAndAddProject };
}

/** 取 localStorage（node 环境 / 隐私模式下为 null，调用方需容错） */
function getLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * 当前选中项目：按 path 持久化，重启后回到上次选中的项目。
 *
 * 为什么用 path 而不是 index：项目增删或顺序变化都会让 index 漂移
 * （删掉第 1 个后，原本的第 2 个变成第 0 个 → 选中项悄悄换成别的项目）。
 * path 是稳定标识，下标每次由 path 反查，天然跟随列表变化。
 */
export function useSelectedProject(projects: ProjectInfo[]): {
  currentProjectIndex: number;
  switchCurrentProject: (index: number) => void;
  selectProjectByPath: (path: string | null) => void;
} {
  const [selectedPath, setSelectedPath] = useState<string | null>(() =>
    readSelectedProjectPath(getLocalStorage()),
  );

  const selectProjectByPath = useCallback((path: string | null) => {
    setSelectedPath(path);
    writeSelectedProjectPath(getLocalStorage(), path);
  }, []);

  const currentProjectIndex = resolveSelectedIndex(projects, selectedPath);
  const canonicalPath = resolveCanonicalPath(projects, selectedPath);

  // 自愈：首次运行 / 选中的项目被移除 / 路径失效（目录改名）→ 收敛到列表第一项并落盘。
  // 项目列表尚空（异步加载中）时 canonicalPath 为 null，不做任何写入。
  useEffect(() => {
    if (!canonicalPath || canonicalPath === selectedPath) return;
    selectProjectByPath(canonicalPath);
  }, [canonicalPath, selectedPath, selectProjectByPath]);

  const switchCurrentProject = useCallback(
    (index: number) => {
      const target = projects[index];
      if (!target) return;
      selectProjectByPath(target.path);
    },
    [projects, selectProjectByPath],
  );

  return { currentProjectIndex, switchCurrentProject, selectProjectByPath };
}

/** 从 localStorage 读取已完成「添加项目诊断」的项目路径集合（解析失败视为空） */
function loadOnboardedPaths(): Set<string> {
  try {
    const raw = localStorage.getItem(ONBOARDED_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* ignore */
  }
  return new Set();
}

/** 将项目路径集合持久化到 localStorage（写失败静默忽略） */
function persistOnboardedPaths(paths: Set<string>): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, JSON.stringify([...paths]));
  } catch {
    /* ignore */
  }
}

/** 已完成「添加项目诊断」的项目路径集合（持久化到 localStorage，重启后仍可用） */
export function useOnboardedProjects(): {
  onboardedPaths: Set<string>;
  markOnboarded: (path: string) => void;
} {
  const [onboardedPaths, setOnboardedPaths] = useState<Set<string>>(loadOnboardedPaths);

  const markOnboarded = useCallback((path: string) => {
    setOnboardedPaths((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev).add(path);
      persistOnboardedPaths(next);
      return next;
    });
  }, []);

  return { onboardedPaths, markOnboarded };
}

export function useLoadInitialState(handlers: {
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
          setCurrentPage('inspect');
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

export function usePersistProjects(projects: ProjectInfo[], loaded: boolean): void {
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
