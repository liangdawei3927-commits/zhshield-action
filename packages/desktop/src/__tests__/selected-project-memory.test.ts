import { describe, it, expect } from 'vitest';
import {
  SELECTED_PROJECT_PATH_KEY,
  readSelectedProjectPath,
  resolveCanonicalPath,
  resolveSelectedIndex,
  writeSelectedProjectPath,
  type PathStorage,
  type ProjectRef,
} from '../project-selection';

/**
 * 当前选中项目的记忆逻辑测试
 *
 * 背景回归：侧边栏「项目管理」选中项原先只存内存（useState(0)），
 * 重启后固定回到列表第一项 —— 用户选了第二个项目，重启就跑回第一个。
 *
 * 本文件覆盖 app-logic 中 useSelectedProject 所依赖的纯逻辑：
 *   1. 持久化读写（含 storage 不可用降级）
 *   2. 按 path 反查下标（index 漂移场景：增删项目后不错位）
 *   3. 自愈收敛（首次运行 / 项目被删 / 路径失效 → 落到第一项）
 */

/** 内存版 PathStorage 桩：模拟一次运行的 localStorage */
function createStorage(initial?: Record<string, string>): PathStorage & {
  dump: () => Record<string, string>;
} {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

const A = { name: 'project-a', path: '/work/a' };
const B = { name: 'project-b', path: '/work/b' };
const C = { name: 'project-c', path: '/work/c' };

describe('选中项目持久化读写', () => {
  it('storage 不可用时读取返回 null 且写入不抛异常', () => {
    expect(readSelectedProjectPath(null)).toBeNull();
    expect(() => writeSelectedProjectPath(null, '/work/a')).not.toThrow();
  });

  it('空串 / 仅空白视为未设置', () => {
    expect(readSelectedProjectPath(createStorage({ [SELECTED_PROJECT_PATH_KEY]: '' }))).toBeNull();
    expect(
      readSelectedProjectPath(createStorage({ [SELECTED_PROJECT_PATH_KEY]: '   ' })),
    ).toBeNull();
  });

  it('写入后可读回同一条路径', () => {
    const storage = createStorage();
    writeSelectedProjectPath(storage, B.path);
    expect(readSelectedProjectPath(storage)).toBe(B.path);
  });

  it('传入 null 会清除已保存的路径', () => {
    const storage = createStorage({ [SELECTED_PROJECT_PATH_KEY]: B.path });
    writeSelectedProjectPath(storage, null);
    expect(readSelectedProjectPath(storage)).toBeNull();
    expect(storage.dump()[SELECTED_PROJECT_PATH_KEY]).toBeUndefined();
  });

  it('底层 getItem 抛错时读取降级为 null（不冒泡到 UI）', () => {
    const broken: PathStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(readSelectedProjectPath(broken)).toBeNull();
  });
});

describe('按 path 反查下标（重启后恢复选中项）', () => {
  it('命中持久化的路径 → 返回其当前位置', () => {
    expect(resolveSelectedIndex([A, B, C], B.path)).toBe(1);
  });

  it('未持久化 → 落到第一个', () => {
    expect(resolveSelectedIndex([A, B, C], null)).toBe(0);
  });

  it('列表为空 → 返回 0（调用方负责「无项目」空态）', () => {
    expect(resolveSelectedIndex([], B.path)).toBe(0);
  });

  it('持久化路径已不在列表（项目被移除 / 目录改名）→ 落到第一个', () => {
    expect(resolveSelectedIndex([A, C], B.path)).toBe(0);
  });

  it('回归：新增项目后下标随 path 自动跟随，不会错位到别的项目', () => {
    // 用户在 [A,B] 里选了 B，然后新增 C —— B 仍是当前项目
    expect(resolveSelectedIndex([A, B], B.path)).toBe(1);
    expect(resolveSelectedIndex([A, B, C], B.path)).toBe(1);
    expect([A, B, C][resolveSelectedIndex([A, B, C], B.path)].path).toBe(B.path);
  });

  it('回归：删掉前面的项目后，同一个 path 的新下标指向同一项目', () => {
    // 删除 A：[A,B,C] → [B,C]，B 的下标从 1 变成 0，但选中的仍是 B
    const before = resolveSelectedIndex([A, B, C], B.path);
    const after = resolveSelectedIndex([B, C], B.path);
    expect([A, B, C][before].path).toBe(B.path);
    expect([B, C][after].path).toBe(B.path);
    expect(after).toBe(0);
  });

  it('模拟重启：同一份存储在新实例中仍恢复上次选中的项目', () => {
    // 第一次运行：切到 C
    const storage = createStorage();
    writeSelectedProjectPath(storage, C.path);
    // 重启（内存状态全部重置，只共享 storage）
    const restoredPath = readSelectedProjectPath(storage);
    const projects = [A, B, C];
    const index = resolveSelectedIndex(projects, restoredPath);
    expect(projects[index].name).toBe('project-c');
  });
});

describe('持久化值自愈收敛', () => {
  it('项目列表尚空（异步加载中）→ 返回 null，不覆盖用户已保存的选择', () => {
    expect(resolveCanonicalPath([], B.path)).toBeNull();
  });

  it('路径有效 → 收敛目标为它自己（幂等，不产生多余写入）', () => {
    expect(resolveCanonicalPath([A, B, C], B.path)).toBe(B.path);
  });

  it('路径失效 → 收敛到第一项，供上层落盘', () => {
    expect(resolveCanonicalPath([A, C], B.path)).toBe(A.path);
  });

  it('首次运行无持久化值 → 收敛到第一项', () => {
    expect(resolveCanonicalPath([A, B], null)).toBe(A.path);
  });
});

describe('多次运行的状态迁移（模拟真实使用序列）', () => {
  /** 模拟一次「应用启动 + 一帧渲染」：读存储 → 解析下标 → 自愈落盘 */
  function boot(projects: ProjectRef[], storage: PathStorage) {
    const selectedPath = readSelectedProjectPath(storage);
    const index = resolveSelectedIndex(projects, selectedPath);
    const canonical = resolveCanonicalPath(projects, selectedPath);
    if (canonical && canonical !== selectedPath) writeSelectedProjectPath(storage, canonical);
    return { index, active: projects[index]?.path ?? null };
  }

  it('新增第二个项目并切过去 → 重启后仍是它（用户报的核心问题）', () => {
    const storage = createStorage();

    // 第 1 次运行：只有一个项目 A
    expect(boot([A], storage).active).toBe(A.path);

    // 同一次运行内新增 B 并切换（addProject 后会自动选中）
    writeSelectedProjectPath(storage, B.path);

    // 重启：列表已有 [A, B]，应恢复 B 而不是回到 A
    expect(boot([A, B], storage)).toEqual({ index: 1, active: B.path });
    // 再重启一次也稳定
    expect(boot([A, B], storage)).toEqual({ index: 1, active: B.path });
  });

  it('项目变多后（A/B/C/D）依旧稳定停在内存外的那个项目', () => {
    const storage = createStorage({ [SELECTED_PROJECT_PATH_KEY]: C.path });
    const D = { name: 'project-d', path: '/work/d' };
    expect(boot([A, B, C, D], storage).index).toBe(2);
    expect(boot([A, B, C, D], storage).active).toBe(C.path);
  });

  it('当前项目被删除 → 回落到第一项并改写入存储（下次重启不再指向已删项目）', () => {
    const storage = createStorage({ [SELECTED_PROJECT_PATH_KEY]: B.path });
    expect(boot([A, B, C], storage).index).toBe(1);
    // 删除 B
    const after = boot([A, C], storage);
    expect(after).toEqual({ index: 0, active: A.path });
    expect(readSelectedProjectPath(storage)).toBe(A.path);
  });

  it('全部项目被删空 → 不改写存储（保留给下次重新添加，避免无谓写盘）', () => {
    const storage = createStorage({ [SELECTED_PROJECT_PATH_KEY]: B.path });
    expect(boot([], storage).active).toBeNull();
    expect(readSelectedProjectPath(storage)).toBe(B.path);
  });
});
