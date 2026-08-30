/**
 * manifest.mjs — tools.json 清单读取与工具可执行名映射
 *
 * 依赖: 仅 node 内置模块（node:fs/node:path），node 20+。
 */

import { existsSync, readFileSync } from 'node:fs';
import { MANIFEST_PATH } from './constants.mjs';

/** 读取并校验 tools.json */
export function readManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`install-tools: 清单不存在: ${MANIFEST_PATH}`);
    process.exit(2);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch (e) {
    console.error(`install-tools: tools.json 解析失败: ${e.message}`);
    process.exit(2);
  }
  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
    console.error('install-tools: tools.json 缺少 tools 数组');
    process.exit(2);
  }
  return manifest;
}

/** 工具在 PATH 中的可执行名（Windows 下 npm bin 为 .cmd） */
export function binNameFor(tool) {
  if (tool.install === 'npm') return tool.npm.binName || tool.name;
  if (tool.install === 'binary') return tool.binary.binName || tool.name;
  return tool.name;
}

/** 供主文件复用清单路径（测试/诊断） */
export { MANIFEST_PATH };
