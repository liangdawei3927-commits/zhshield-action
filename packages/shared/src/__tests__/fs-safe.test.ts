import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { expandHome } from '../fs-safe';

/**
 * expandHome：把路径开头的 `~` 展开为用户 home。
 *
 * 2026-10-24 引入，起因是备份目录配置写的是字面量 `~/zhshield-backups/<project>`：
 * 求备份根的一侧未展开而打开侧展开，两侧口径不一致，导致所有备份目录都打不开。
 * 这里锁定「哪些形态算 home、哪些不算」，防止后续有人放松判断反过来制造越界。
 */
describe('expandHome', () => {
  it('展开 ~ 与 ~/ 前缀为用户 home', () => {
    expect(expandHome('~')).toBe(os.homedir());
    expect(expandHome('~/zhshield-backups')).toBe(path.join(os.homedir(), 'zhshield-backups'));
    expect(expandHome('~/a/b/c')).toBe(path.join(os.homedir(), 'a', 'b', 'c'));
  });

  it('绝对路径与相对路径原样返回', () => {
    expect(expandHome('/Volumes/Ext/backups')).toBe('/Volumes/Ext/backups');
    expect(expandHome('zhshield-backups')).toBe('zhshield-backups');
  });

  it('~ 后不是分隔符时不展开（~foo 是普通目录名，不得当成 home）', () => {
    expect(expandHome('~foo/bar')).toBe('~foo/bar');
  });

  it('空字符串原样返回', () => {
    expect(expandHome('')).toBe('');
  });
});
