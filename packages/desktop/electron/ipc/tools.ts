/**
 * 工具就绪探测与引导安装 IPC（ipc/tools.ts）
 *
 * 「工具半自动」原则的落地端点：云端 /resolve/tools 决定本项目需要哪些工具，
 * 本模块只做①本地三层探测（项目 node_modules/.bin → PATH → ~/.zhshield/bin）
 * 与②用户确认后的引导安装（复用 scripts/install-tools.mjs，装到 ~/.zhshield/bin）。
 * 绝不静默安装——安装动作必须由用户在渲染层点击触发。
 */
import { ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import * as path from 'node:path';
import { findLocalToolBin, findZhshieldToolBin } from '@zh/inspect';
import {
  cloudResolveTools,
  getCachedProfile,
  getDefaultOrgId,
  wisdomBrainSync,
} from '../ipc-context';

const execFileAsync = promisify(execFile);

/** 云端工具 ID → 安装清单（scripts/tools.json）中的可执行名 */
const TOOL_BIN_NAME: Record<string, string> = {
  'dep-cruiser': 'depcruise',
};

/** 工具就绪状态（探测三层来源） */
export type ToolReadiness = 'project' | 'path' | 'shared' | 'missing';

export interface ToolStatusRow {
  toolId: string;
  status: ToolReadiness;
  /** 命中的可执行文件绝对路径（missing 时为 null） */
  bin: string | null;
}

export interface ToolsStatusResult {
  /** 工具清单来源：cloud（/resolve/tools）或 local（离线默认） */
  source: 'cloud' | 'local';
  tools: ToolStatusRow[];
}

export interface ToolsInstallResult {
  ok: boolean;
  /** 打包环境暂不支持（安装脚本属仓库资产）；开发环境为脚本退出码 */
  reason?: 'packaged' | 'script_error';
  output: string;
}

/** 本项目应就绪的工具清单：云端裁剪优先，失败降级本地配置全集 */
async function resolveToolIds(): Promise<{ ids: string[]; source: 'cloud' | 'local' }> {
  try {
    const orgId = await getDefaultOrgId();
    if (orgId) {
      const ids = await cloudResolveTools(orgId, getCachedProfile() ?? undefined);
      if (Array.isArray(ids) && ids.length > 0) {
        return { ids: ids.map(String), source: 'cloud' };
      }
    }
  } catch (err) {
    console.warn(
      '[tools] 云端工具清单不可用，降级本地默认:',
      err instanceof Error ? err.message : String(err),
    );
  }
  return { ids: wisdomBrainSync.getRuleSync().getConfiguredToolIds(), source: 'local' };
}

/** 单工具三层探测：项目本地 → PATH（--version 可执行）→ zhshield 共享目录 */
async function probeTool(toolId: string, projectPath?: string): Promise<ToolStatusRow> {
  const binName = TOOL_BIN_NAME[toolId] ?? toolId;
  if (projectPath) {
    const local = findLocalToolBin(binName, projectPath);
    if (local) return { toolId, status: 'project', bin: local };
  }
  try {
    await execFileAsync(binName, ['--version'], { timeout: 8_000 });
    return { toolId, status: 'path', bin: binName };
  } catch {
    // PATH 不可用（ENOENT 或版本探测失败）
  }
  const shared = findZhshieldToolBin(binName);
  if (shared) return { toolId, status: 'shared', bin: shared };
  return { toolId, status: 'missing', bin: null };
}

/** 从 dir 逐级向上找 scripts/install-tools.mjs（最多 8 级；开发环境限定） */
async function findScriptIn(dir: string, depth: number): Promise<string | null> {
  if (depth >= 8) return null;
  const candidate = path.join(dir, 'scripts', 'install-tools.mjs');
  try {
    await access(candidate);
    return candidate;
  } catch {
    // 当前层无，向上一级
  }
  const parent = path.dirname(dir);
  if (parent === dir) return null;
  return findScriptIn(parent, depth + 1);
}

/** 从 __dirname 向上定位仓库根的 scripts/install-tools.mjs（开发环境限定） */
function locateInstallScript(): Promise<string | null> {
  return findScriptIn(__dirname, 0);
}

/** 引导安装：用户已在渲染层确认；复用 install-tools.mjs --only 安装到 ~/.zhshield/bin */
async function installTools(toolIds: string[]): Promise<ToolsInstallResult> {
  const names = toolIds.map((id) => TOOL_BIN_NAME[id] ?? id).join(',');
  const script = await locateInstallScript();
  if (!script) {
    return { ok: false, reason: 'packaged', output: '安装脚本不可用（打包环境暂不支持引导安装）' };
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, [script, '--only', names], {
      timeout: 10 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, output: stdout };
  } catch (err) {
    const e = err as { stdout?: string; message?: string };
    return { ok: false, reason: 'script_error', output: e.stdout || e.message || String(err) };
  }
}

export function registerToolsIpc(): void {
  ipcMain.handle(
    'tools:status',
    async (_event, payload?: { projectPath?: string }): Promise<ToolsStatusResult> => {
      const { ids, source } = await resolveToolIds();
      const rows = await Promise.all(ids.map((id) => probeTool(id, payload?.projectPath)));
      return { source, tools: rows };
    },
  );

  ipcMain.handle(
    'tools:install',
    async (_event, payload: { toolIds?: unknown }): Promise<ToolsInstallResult> => {
      const ids = Array.isArray(payload?.toolIds)
        ? payload.toolIds.filter((x): x is string => typeof x === 'string')
        : [];
      if (ids.length === 0) {
        return { ok: false, reason: 'script_error', output: '未指定要安装的工具' };
      }
      console.log(`[tools] 用户确认安装: ${ids.join(', ')}`);
      return installTools(ids);
    },
  );
}
