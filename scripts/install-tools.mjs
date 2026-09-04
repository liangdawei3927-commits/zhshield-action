#!/usr/bin/env node
/**
 * install-tools.mjs — 智汇码盾外部工具安装脚本（CLI 入口）
 *
 * 用途:
 *   读取 scripts/tools.json 版本清单，探测本机缺失的外部工具并安装到
 *   ~/.zhshield/bin（用户级共享 bin 目录，CLI 与 desktop 共用）。
 *
 * 用法:
 *   node scripts/install-tools.mjs            # 探测并安装缺失工具
 *   node scripts/install-tools.mjs --check    # 只探测不安装（退出码 0=全可用，1=有缺失）
 *   node scripts/install-tools.mjs --force    # 强制重装（PATH 命中的工具仍跳过）
 *   node scripts/install-tools.mjs --help     # 帮助
 *
 * 目录约定:
 *   ~/.zhshield/bin/          二进制与 npm bin 软链（加入 PATH 即可被消费）
 *   ~/.zhshield/tools/<tool>/ npm 工具私有安装目录（npm install --prefix）
 *
 * 安装方式:
 *   - npm 工具: 安装到 ~/.zhshield/tools/<tool>，bin 软链到 ~/.zhshield/bin
 *     （Windows 软链失败时降级为写 .cmd 转发 shim）。版本探测优先读本地
 *     package.json；不支持 --version 的工具（如 ts-prune）在清单中标记
 *     versionFlag: false
 *   - binary 工具（github-release）: 按 tools.json 的 URL 模板下载官方 release
 *     资产，优先抓取官方 .sha256 checksum 文件核验，解压后 chmod +x 放入
 *     ~/.zhshield/bin
 *   - binary 工具（pypi，如 semgrep）: 官方不再发布 release 二进制，走
 *     pipx/uv tool install（bin 落到 ~/.zhshield/bin），pip --user 兜底
 *
 * 与 resolveToolCommand 的关系:
 *   packages/inspect/src/adapters/tool-bin.ts 的 resolveToolCommand 目前只查
 *   PATH + node_modules/.bin；把 ~/.zhshield/bin 纳入其查找范围是另一个独立
 *   任务。本脚本只保证目录约定明确、安装产物就位、输出清晰。
 *
 * 实现说明:
 *   本文件仅负责 CLI 编排（参数解析、逐工具处理、汇总输出）。各职责域已拆到
 *   scripts/lib/install-tools/ 下的独立模块：
 *     constants.mjs   共享常量与输出辅助
 *     manifest.mjs    tools.json 清单读取与可执行名映射
 *     detect.mjs      工具探测与版本检测
 *     download.mjs    下载链（fetch→https.request→curl）与 sha256 校验
 *     link.mjs        bin 软链（Windows 降级 .cmd shim）
 *     installers.mjs  各安装方式实现与分发
 *
 * 依赖: 仅 node 内置模块（node:util/node:path/node:os），node 20+。
 */

import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { BIN_DIR, TOOLS_DIR, IS_WIN, log, warn, ok, fail } from './lib/install-tools/constants.mjs';
import { readManifest, binNameFor } from './lib/install-tools/manifest.mjs';
import {
  findInPath,
  getToolVersion,
  getNpmInstalledVersion,
  versionsMatch,
  supportsVersionFlag,
  probeTimeoutFor,
} from './lib/install-tools/detect.mjs';
import { installTool } from './lib/install-tools/installers.mjs';

function printHelp() {
  log(`install-tools — 智汇码盾外部工具安装脚本

用法:
  node scripts/install-tools.mjs            # 探测并安装缺失工具
  node scripts/install-tools.mjs --check    # 只探测不安装（退出码 0=全可用，1=有缺失）
  node scripts/install-tools.mjs --force    # 强制重装（PATH 命中的工具仍跳过）
  node scripts/install-tools.mjs --help     # 帮助

目录约定:
  ~/.zhshield/bin/          二进制与 npm bin 软链（加入 PATH 即可被消费）
  ~/.zhshield/tools/<tool>/ npm 工具私有安装目录

说明:
  工具版本清单见 scripts/tools.json；安装入口与报告层提示一致（zhshield tools install）。`);
}

/** 打印清单头部信息 */
function printHeader(manifest, values) {
  log(`[zhshield tools] 清单: ${manifest.tools.length} 个工具（${manifest.checked} 校验）`);
  log(`[zhshield tools] bin 目录: ${BIN_DIR}`);
  if (values.check) log('[zhshield tools] --check 模式：只探测不安装');
  if (values.force) log('[zhshield tools] --force 模式：强制重装');
  log('');
}

/** 内置工具（项目自身依赖提供，无需安装） */
function checkBuiltin(tool, label) {
  if (tool.install !== 'builtin') return null;
  log(`  - ${label} 内置（项目依赖提供，跳过）`);
  return { tool, status: 'builtin' };
}

/** PATH 命中（PATH 工具由用户管理，--force 也不重装） */
function checkPath(tool, label, binName) {
  const pathHit = findInPath(binName);
  if (!pathHit) return null;
  if (!supportsVersionFlag(tool)) {
    ok(`${label} 可用（PATH: ${pathHit}）`);
    return { tool, status: 'path' };
  }
  const actual = getToolVersion(pathHit, probeTimeoutFor(tool));
  if (actual && versionsMatch(actual, tool.version)) {
    ok(`${label} 可用（PATH: ${pathHit}）`);
  } else {
    warn(
      `${label} PATH 命中但版本不符（${actual || '未知'} ≠ ${tool.version}），PATH 工具由用户管理，跳过`,
    );
  }
  return { tool, status: 'path' };
}

/** ~/.zhshield/bin 命中（版本匹配则可用，否则重装） */
function checkLocal(tool, label, binName, force) {
  const localBin = join(BIN_DIR, IS_WIN ? `${binName}.cmd` : binName);
  if (!existsSync(localBin) || force) return null;
  const actual =
    tool.install === 'npm'
      ? getNpmInstalledVersion(tool)
      : getToolVersion(localBin, probeTimeoutFor(tool));
  if (actual && versionsMatch(actual, tool.version)) {
    ok(`${label} 可用（${localBin}）`);
    return { tool, status: 'local' };
  }
  warn(`${label} 本地版本不符（${actual || '未知'} ≠ ${tool.version}），重装`);
  return null;
}

/** 缺失 → 安装（或 --check 只报告） */
async function installOrReport(tool, label, values) {
  if (values.check) {
    fail(`${label} 缺失`);
    return { row: { tool, status: 'missing' }, installed: 0, missing: 1 };
  }
  log(`  → ${label} 安装中...`);
  try {
    const r = await installTool(tool);
    ok(`${label} 已安装到 ${BIN_DIR}${r?.verified === false ? '（unverified）' : ''}`);
    return { row: { tool, status: 'installed', verified: r?.verified }, installed: 1, missing: 0 };
  } catch (e) {
    fail(`${label} 安装失败: ${e.message}`);
    return { row: { tool, status: 'error' }, installed: 0, missing: 1 };
  }
}

/** 处理单个工具：按 builtin → PATH → 本地 bin → 安装 依次判定 */
async function processTool(tool, values) {
  const binName = binNameFor(tool);
  const label = `${tool.name.padEnd(12)} ${String(tool.version).padEnd(9)}`;
  const builtinRow = checkBuiltin(tool, label);
  if (builtinRow) return { row: builtinRow, installed: 0, missing: 0 };
  const pathRow = checkPath(tool, label, binName);
  if (pathRow) return { row: pathRow, installed: 0, missing: 0 };
  const localRow = checkLocal(tool, label, binName, values.force);
  if (localRow) return { row: localRow, installed: 0, missing: 0 };
  return installOrReport(tool, label, values);
}

/** 汇总输出与退出码 */
function printSummary(rows, installedCount, missingCount, values) {
  log('');
  const byStatus = (s) => rows.filter((r) => r.status === s).length;
  const available = byStatus('path') + byStatus('local') + byStatus('builtin');
  log(
    `[zhshield tools] 汇总: ${available} 可用 / ${installedCount} 新安装 / ${missingCount} 缺失或失败`,
  );
  if (values.check) {
    log(
      missingCount === 0
        ? '[zhshield tools] 全部工具可用。'
        : `[zhshield tools] ${missingCount} 个工具缺失，请运行 node scripts/install-tools.mjs 安装。`,
    );
    process.exit(missingCount > 0 ? 1 : 0);
  }
  if (installedCount > 0) {
    log(
      `已将 ${installedCount} 个工具安装到 ${BIN_DIR}，请将其加入 PATH（或使用 zhshield tools install 的等效入口）`,
    );
  } else if (missingCount === 0) {
    log('无需安装：全部工具已可用。');
  } else {
    log(`有 ${missingCount} 个工具安装失败，请检查上方错误信息后重试。`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      only: { type: 'string', default: '' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    printHelp();
    process.exit(0);
  }
  const manifest = readManifest();
  // --only a,b：只处理清单中指定名称的工具（桌面端按需引导安装入口）
  if (values.only) {
    const wanted = new Set(
      String(values.only)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    manifest.tools = manifest.tools.filter((t) => wanted.has(t.name));
  }
  printHeader(manifest, values);
  const rows = [];
  let installedCount = 0;
  let missingCount = 0;
  for (const tool of manifest.tools) {
    const r = await processTool(tool, values);
    rows.push(r.row);
    installedCount += r.installed;
    missingCount += r.missing;
  }
  printSummary(rows, installedCount, missingCount, values);
}

// 直接执行时运行 main（被 import 时仅暴露函数，便于测试）
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().catch((e) => {
    console.error('install-tools: 错误:', e.message);
    process.exit(2);
  });
}

// 导出供测试/复用（各职责域实现见 scripts/lib/install-tools/）
export {
  readManifest,
  binNameFor,
  findInPath,
  getToolVersion,
  getNpmInstalledVersion,
  versionsMatch,
  supportsVersionFlag,
  installTool,
  BIN_DIR,
  TOOLS_DIR,
};
