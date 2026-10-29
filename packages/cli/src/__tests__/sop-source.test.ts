import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  STALE_CACHE_DAYS,
  formatAge,
  readCacheFreshness,
  resolveDesktopCacheDir,
  resolveSopCacheDir,
} from '../sop-source';
import type { SopCacheEnv } from '../sop-source';

/**
 * 云端规则缓存定位的行为契约。
 *
 * 这一层的价值全在「判错也不出声」的代价上：CLI 若误判成"没有云端规则"，
 * 它会安静地只用内置 43 条跑完，而云端那 52 条（含全部阻断型门禁规则）整段缺席 ——
 * 终端上没有任何区别，只是门禁永久无声。所以每条断言都围绕「能不能用 + 说不说清」。
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-sop-source-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 造一个「可用」的缓存目录：{dir}/modules/*.db */
function makeCacheDir(name: string, files: Record<string, string> = { 'a.db': '[]' }): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, 'modules', file), content, 'utf-8');
  }
  return dir;
}

function env(overrides: Partial<SopCacheEnv> = {}): SopCacheEnv {
  return {
    env: {},
    platform: 'darwin',
    homeDir: path.join(tmpRoot, 'home'),
    ...overrides,
  };
}

describe('resolveDesktopCacheDir — 平台默认路径', () => {
  it('Given macOS，Then 落在 ~/Library/Application Support/@zh/desktop/sop-cache——与 electron userData 同布局，两边读同一份', () => {
    const dir = resolveDesktopCacheDir(
      env({ platform: 'darwin', homeDir: '/Users/x', env: {} }),
    );
    expect(dir).toBe('/Users/x/Library/Application Support/@zh/desktop/sop-cache');
  });

  it('Given Windows 且有 APPDATA，Then 用 %APPDATA% 而非 HOME——Roaming 才是 userData 的落点', () => {
    const dir = resolveDesktopCacheDir(
      env({ platform: 'win32', homeDir: 'C:\\Users\\x', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' } }),
    );
    expect(dir).toBe(path.join('C:\\Users\\x\\AppData\\Roaming', '@zh', 'desktop', 'sop-cache'));
  });

  it('Given Windows 但无 APPDATA，Then 回退 %HOME%/AppData/Roaming——缺环境变量不该直接崩或返回空', () => {
    const dir = resolveDesktopCacheDir(env({ platform: 'win32', homeDir: '/h', env: {} }));
    expect(dir).toBe(path.join('/h', 'AppData', 'Roaming', '@zh', 'desktop', 'sop-cache'));
  });

  it('Given Linux 且设了 XDG_CONFIG_HOME，Then 遵循 XDG 而非硬编码 ~/.config', () => {
    const dir = resolveDesktopCacheDir(
      env({ platform: 'linux', homeDir: '/home/x', env: { XDG_CONFIG_HOME: '/cfg' } }),
    );
    expect(dir).toBe(path.join('/cfg', '@zh', 'desktop', 'sop-cache'));
  });

  it('Given Linux 未设 XDG，Then 落 ~/.config——XDG 默认值', () => {
    const dir = resolveDesktopCacheDir(env({ platform: 'linux', homeDir: '/home/x', env: {} }));
    expect(dir).toBe(path.join('/home/x', '.config', '@zh', 'desktop', 'sop-cache'));
  });
});

describe('resolveSopCacheDir — 可用性判据', () => {
  it('Given 显式 ZH_SOP_CACHE_DIR 且含 modules/，Then 用它并标明来源', () => {
    const dir = makeCacheDir('explicit');
    const result = resolveSopCacheDir(env({ env: { ZH_SOP_CACHE_DIR: dir } }));
    expect(result.dir).toBe(dir);
    expect(result.origin).toContain('ZH_SOP_CACHE_DIR');
    expect(result.reason).toBeUndefined();
  });

  it('Given 显式路径存在但没有 modules/，Then 判不可用且写明原因——空目录会让规则加载静默返回 0', () => {
    const empty = path.join(tmpRoot, 'empty-cache');
    fs.mkdirSync(empty, { recursive: true });
    const result = resolveSopCacheDir(env({ env: { ZH_SOP_CACHE_DIR: empty } }));
    expect(result.dir).toBeUndefined();
    expect(result.reason).toContain('modules');
  });

  it('Given 显式路径指向不存在的目录，Then 不可用——不猜测、不创建', () => {
    const result = resolveSopCacheDir(
      env({ env: { ZH_SOP_CACHE_DIR: path.join(tmpRoot, 'nope') } }),
    );
    expect(result.dir).toBeUndefined();
    expect(result.reason).toContain('modules');
  });

  it('Given 显式路径不可用但桌面缓存可用，Then 仍判不可用——显式胜过隐式，静默换源是最难查的失真', () => {
    const desktopHome = path.join(tmpRoot, 'home');
    const desktopDir = path.join(desktopHome, 'Library', 'Application Support', '@zh', 'desktop', 'sop-cache');
    fs.mkdirSync(path.join(desktopDir, 'modules'), { recursive: true });
    fs.writeFileSync(path.join(desktopDir, 'modules', 'a.db'), '[]');

    const result = resolveSopCacheDir(
      env({
        homeDir: desktopHome,
        env: { ZH_SOP_CACHE_DIR: path.join(tmpRoot, 'missing') },
      }),
    );
    expect(result.dir).toBeUndefined();
    expect(result.reason).toContain('不会回退');
  });

  it('Given 未设环境变量且桌面缓存可用，Then 自动发现并标明来源是桌面端缓存', () => {
    const home = path.join(tmpRoot, 'home2');
    const dir = path.join(home, 'Library', 'Application Support', '@zh', 'desktop', 'sop-cache');
    fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'modules', 'a.db'), '[]');

    const result = resolveSopCacheDir(env({ homeDir: home, env: {} }));
    expect(result.dir).toBe(dir);
    expect(result.origin).toContain('桌面端');
  });

  it('Given 未设环境变量且桌面缓存不存在，Then 不可用且原因里带完整路径——用户要能直接照着去查', () => {
    const home = path.join(tmpRoot, 'freshhome');
    const result = resolveSopCacheDir(env({ homeDir: home, env: {} }));
    expect(result.dir).toBeUndefined();
    expect(result.reason).toContain(path.join(home, 'Library'));
  });

  it('Given modules 是文件而非目录，Then 判不可用——existsSync 对文件同样为 true，这里必须区分', () => {
    const dir = path.join(tmpRoot, 'file-instead');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'modules'), 'not a dir');
    const result = resolveSopCacheDir(env({ env: { ZH_SOP_CACHE_DIR: dir } }));
    expect(result.dir).toBeUndefined();
  });

  it('Given ZH_SOP_CACHE_DIR 是空白字符串，Then 视为未设置并走桌面端探测——trim 后为空不算显式指定', () => {
    const home = path.join(tmpRoot, 'home3');
    const result = resolveSopCacheDir(env({ homeDir: home, env: { ZH_SOP_CACHE_DIR: '   ' } }));
    expect(result.dir).toBeUndefined();
    expect(result.reason).toContain('桌面端');
  });
});

describe('readCacheFreshness — 规则有多旧', () => {
  it('Given 两个模块文件，Then fileCount 计 .db 且 updatedAt 取最新——旧的规则文件不该把新鲜度拉低', () => {
    const dir = makeCacheDir('fresh', { 'old.db': '[]', 'new.db': '[]', 'ignore.txt': '' });
    const oldTime = new Date('2026-01-01T00:00:00Z');
    const newTime = new Date('2026-01-05T00:00:00Z');
    fs.utimesSync(path.join(dir, 'modules', 'old.db'), oldTime, oldTime);
    fs.utimesSync(path.join(dir, 'modules', 'new.db'), newTime, newTime);

    const freshness = readCacheFreshness(dir, new Date('2026-01-06T00:00:00Z'));
    expect(freshness.fileCount).toBe(2);
    expect(freshness.updatedAt?.toISOString()).toBe(newTime.toISOString());
    expect(freshness.ageMs).toBe(86_400_000);
  });

  it('Given 目录不可读，Then 返回 fileCount=0 而不是抛错——新鲜度读不到不该让整次扫描失败', () => {
    const freshness = readCacheFreshness(path.join(tmpRoot, 'missing-dir'));
    expect(freshness.fileCount).toBe(0);
    expect(freshness.updatedAt).toBeUndefined();
  });

  it('Given 文件 mtime 在未来（时钟漂移），Then ageMs 归 0 而非负数——负数会让"刚刚"这类文案算错', () => {
    const dir = makeCacheDir('future', { 'a.db': '[]' });
    const future = new Date('2030-01-01T00:00:00Z');
    fs.utimesSync(path.join(dir, 'modules', 'a.db'), future, future);
    const freshness = readCacheFreshness(dir, new Date('2026-01-01T00:00:00Z'));
    expect(freshness.ageMs).toBe(0);
  });

  it('Given 陈旧阈值对外可见，Then 是 7 天——云大脑按日同步，超过一周的阈值已不可信', () => {
    expect(STALE_CACHE_DAYS).toBe(7);
  });
});

describe('formatAge — 人话时间', () => {
  it.each([
    [30_000, '刚刚'],
    [5 * 60_000, '5 分钟前'],
    [3 * 3_600_000, '3 小时前'],
    [9 * 86_400_000, '9 天前'],
  ])('Given %i 毫秒，Then 显示 %s', (ms, expected) => {
    expect(formatAge(ms)).toBe(expected);
  });
});
