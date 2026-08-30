/**
 * link.mjs — bin 软链（Windows 降级为 .cmd 转发 shim）
 *
 * 依赖: 仅 node 内置模块（node:fs/node:path），node 20+。
 */

import {
  mkdirSync, unlinkSync, writeFileSync, symlinkSync, copyFileSync, chmodSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { BIN_DIR, IS_WIN, warn } from './constants.mjs';

/** 把 npm 工具 bin 软链到 ~/.zhshield/bin（Windows 降级为 .cmd 转发 shim） */
export function linkBin(shimPath, binName) {
  mkdirSync(BIN_DIR, { recursive: true });
  const targetName = IS_WIN ? `${binName}.cmd` : binName;
  const target = join(BIN_DIR, targetName);
  try { unlinkSync(target); } catch { /* 不存在则忽略 */ }

  if (IS_WIN) {
    // 转发 shim：调用 tools 目录下 npm 生成的 .cmd（其内部 %~dp0 相对路径仍正确）
    const rel = relative(BIN_DIR, shimPath).replace(/\//g, '\\');
    writeFileSync(target, `@echo off\r\n"%~dp0${rel}" %*\r\n`);
    return;
  }
  try {
    symlinkSync(shimPath, target);
  } catch (e) {
    // 软链失败（如跨设备）降级为拷贝
    warn(`${binName}: 软链失败（${e.message}），降级为拷贝`);
    copyFileSync(shimPath, target);
    chmodSync(target, 0o755);
  }
}
