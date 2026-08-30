/**
 * constants.mjs — install-tools 共享常量与输出辅助
 *
 * 目录约定:
 *   ~/.zhshield/bin/          二进制与 npm bin 软链（加入 PATH 即可被消费）
 *   ~/.zhshield/tools/<tool>/ npm 工具私有安装目录（npm install --prefix）
 *
 * 依赖: 仅 node 内置模块（node:path/node:os），node 20+。
 */

import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

// 本模块位于 scripts/lib/install-tools/，向上两级即 scripts/ 目录
const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MANIFEST_PATH = join(SCRIPTS_DIR, 'tools.json');

export const HOME = homedir();
export const ZH_SHIELD_DIR = join(HOME, '.zhshield');
export const BIN_DIR = join(ZH_SHIELD_DIR, 'bin');
export const TOOLS_DIR = join(ZH_SHIELD_DIR, 'tools');

export const IS_WIN = platform() === 'win32';

/** 普通信息输出 */
export function log(msg = '') {
  console.log(msg);
}

/** 黄色警告输出 */
export function warn(msg) {
  console.warn(`  \x1b[33m⚠ ${msg}\x1b[0m`);
}

/** 绿色成功输出 */
export function ok(msg) {
  console.log(`  \x1b[32m✓ ${msg}\x1b[0m`);
}

/** 红色失败输出 */
export function fail(msg) {
  console.log(`  \x1b[31m✗ ${msg}\x1b[0m`);
}
