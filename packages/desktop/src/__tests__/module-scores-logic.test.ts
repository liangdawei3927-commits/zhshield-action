import { describe, expect, it, vi } from 'vitest';
import { collectModuleScores } from '../pages/module-scores-logic';
import type { ModuleProfileData } from '../types/electron';

const modules: ModuleProfileData[] = [
  { path: '/p/packages/web', type: 'frontend' },
  { path: '/p/packages/server', type: 'backend' },
];

function scoreOf(score: number) {
  return { score, dimensions: [], summary: 'ok', timestamp: '' };
}

describe('collectModuleScores — 模块级评分汇集', () => {
  it('按 path 拉取各模块评分并汇成视图，按 path 排序', async () => {
    const getScore = vi.fn(async (p: string) => {
      if (p === '/p/packages/server') return scoreOf(88);
      if (p === '/p/packages/web') return scoreOf(95);
      return null;
    });
    const views = await collectModuleScores(modules, getScore);

    expect(views).toHaveLength(2);
    // 按 path 排序：server 在 web 之前
    expect(views[0].path).toBe('/p/packages/server');
    expect(views[0].name).toBe('server');
    expect(views[0].type).toBe('backend');
    expect(views[0].score).toBe(88);
    expect(views[1].name).toBe('web');
    expect(views[1].type).toBe('frontend');
    expect(views[1].score).toBe(95);
    expect(getScore).toHaveBeenCalledTimes(2);
  });

  it('模块无评分时 score 为 null，name 取路径末段', async () => {
    const getScore = vi.fn(async () => null);
    const views = await collectModuleScores([{ path: '/p/x', type: 'cli' }], getScore);
    expect(views[0].score).toBeNull();
    expect(views[0].name).toBe('x');
    expect(views[0].summary).toBeNull();
  });

  it('空模块列表返回空视图', async () => {
    const getScore = vi.fn(async () => scoreOf(90));
    expect(await collectModuleScores([], getScore)).toEqual([]);
    expect(getScore).not.toHaveBeenCalled();
  });
});

describe('collectModuleScores — 拒绝相对路径（跨项目串数据防线）', () => {
  it('相对路径不发起查询、score 为 null，并打告警', async () => {
    const getScore = vi.fn(async () => scoreOf(95));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const views = await collectModuleScores(
        [{ path: 'packages/ui', type: 'frontend' }],
        getScore,
      );
      expect(getScore).not.toHaveBeenCalled();
      expect(views[0].score).toBeNull();
      expect(views[0].name).toBe('ui');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('不是绝对路径'));
    } finally {
      warn.mockRestore();
    }
  });

  it('绝对路径正常查询（POSIX 与 Windows 两种形态都放行）', async () => {
    const getScore = vi.fn(async (p: string) => scoreOf(p.endsWith('ui') ? 96 : 88));
    const views = await collectModuleScores(
      [
        { path: '/proj/a/packages/ui', type: 'frontend' },
        { path: 'C:\\proj\\a\\packages\\cli', type: 'cli' },
      ],
      getScore,
    );
    expect(getScore).toHaveBeenCalledTimes(2);
    expect(views.find((v) => v.path === '/proj/a/packages/ui')!.score).toBe(96);
    expect(views.find((v) => v.path.startsWith('C:'))!.score).toBe(88);
  });
});
