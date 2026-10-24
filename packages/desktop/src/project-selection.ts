/**
 * 当前选中项目的持久化与解析（project-selection.ts）
 *
 * 背景：选中项目原先只存在内存（useState(0)），重启后恒回到列表第一项，
 * 用户切到第 N 个项目后重启即"乱跑"。这里把「选中哪个项目」按 **path** 持久化，
 * 而不是按 index —— index 会随项目增删、列表顺序变化而漂移，path 才是稳定标识。
 *
 * 本模块刻意不依赖 React / DOM：storage 由调用方注入（localStorage 或测试桩），
 * 因此可在 node 环境下直接单测（desktop 的 vitest environment 为 node）。
 */

/** localStorage key：上次选中的项目路径 */
export const SELECTED_PROJECT_PATH_KEY = 'zh:selected-project';

/** 只依赖最小存储契约，便于注入 localStorage 或测试桩 */
export interface PathStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 项目引用：path 为绝对路径 —— 它才是稳定标识（index 会随增删与排序漂移） */
export interface ProjectRef {
  name: string;
  path: string;
}

/**
 * 读取持久化的选中项目路径。
 * storage 不可用（隐私模式 / node 环境）或值为空串时返回 null。
 */
export function readSelectedProjectPath(storage: PathStorage | null | undefined): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SELECTED_PROJECT_PATH_KEY);
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * 写入 / 清除持久化的选中项目路径（写失败静默：不影响当前会话可用性）。
 * path 为 null 表示清除。
 */
export function writeSelectedProjectPath(
  storage: PathStorage | null | undefined,
  path: string | null,
): void {
  if (!storage) return;
  try {
    if (path) storage.setItem(SELECTED_PROJECT_PATH_KEY, path);
    else storage.removeItem(SELECTED_PROJECT_PATH_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 解析当前应选中的项目下标。
 * - 列表为空 → 0
 * - 持久化路径命中 → 该位置（项目增删后下标自动跟随，不会错位）
 * - 未持久化 / 路径已失效（项目被移除、目录改名）→ 0（第一个）
 */
export function resolveSelectedIndex(
  projects: readonly ProjectRef[],
  selectedPath: string | null,
): number {
  if (projects.length === 0) return 0;
  if (!selectedPath) return 0;
  const idx = projects.findIndex((p) => p.path === selectedPath);
  return idx >= 0 ? idx : 0;
}

/**
 * 计算持久化值应当收敛到的目标路径（用于自愈：首次运行、项目被删、路径失效）。
 * 列表为空时返回 null —— 此时不做写入，保留原值等下次列表加载后再匹配。
 */
export function resolveCanonicalPath(
  projects: readonly ProjectRef[],
  selectedPath: string | null,
): string | null {
  if (projects.length === 0) return null;
  const idx = resolveSelectedIndex(projects, selectedPath);
  return projects[idx]?.path ?? null;
}
