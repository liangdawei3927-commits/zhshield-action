/**
 * AI 编程工具集成 IPC（ipc/ai-tools.ts）
 *
 * ai:loadConfig / ai:saveConfig + 启动时幂等补齐集成文件。
 */

import { app, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

import {
  AI_TOOL_PRESETS,
  buildIntegrationFiles,
  buildOpenCodeConfigJson,
  buildTraeMcpJson,
  type AiToolConfig,
} from '../ai-tool-config';
import { PROJECTS_FILE } from './projects';

const AI_TOOL_FILE = path.join(app.getPath('userData'), 'ai-tool.json');

export interface AiProjectWriteResult {
  path: string;
  ok: boolean;
  error?: string;
  files: string[];
}

export interface AiApplyResult {
  saved: boolean;
  projects: AiProjectWriteResult[];
}

/** OpenCode MCP server 绝对路径（打包后从 asar.unpacked 加载，node 可直接执行） */
function resolveZhshieldMcpPath(): string {
  return path.join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'dist-electron', 'zhshield-mcp.js');
}

/** 合并写入目标项目的 opencode.json：启用时写入 mcp.zhshield，停用时移除该块 */
function writeOpenCodeConfig(projectPath: string, config: AiToolConfig): string | null {
  if (config.id !== 'opencode') return null;
  const configPath = path.join(projectPath, 'opencode.json');
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  const mcpBlock = config.enabled
    ? { type: 'local' as const, command: ['node', resolveZhshieldMcpPath()], enabled: true }
    : null;
  const content = buildOpenCodeConfigJson(existing, mcpBlock);
  if (content === null) {
    console.warn(`[ai:saveConfig] 跳过 opencode.json 写入（无法解析既有配置）: ${configPath}`);
    return null;
  }
  fs.writeFileSync(configPath, content, 'utf-8');
  return 'opencode.json';
}

/** 合并写入目标项目的 .trae/mcp.json：启用时注册 zhshield MCP server，停用时移除 */
function writeTraeMcpConfig(projectPath: string, config: AiToolConfig): string | null {
  if (config.id !== 'trae') return null;
  const configPath = path.join(projectPath, '.trae', 'mcp.json');
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  const mcpBlock = config.enabled
    ? { name: 'zhshield', command: ['node', resolveZhshieldMcpPath()] }
    : null;
  const content = buildTraeMcpJson(existing, mcpBlock);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, content, 'utf-8');
  return '.trae/mcp.json';
}

function writeAiIntegrationFiles(projectPath: string, config: AiToolConfig): AiProjectWriteResult {
  const result: AiProjectWriteResult = { path: projectPath, ok: true, files: [] };
  try {
    const openCodeFile = writeOpenCodeConfig(projectPath, config);
    if (openCodeFile) result.files.push(openCodeFile);
    const traeFile = writeTraeMcpConfig(projectPath, config);
    if (traeFile) result.files.push(traeFile);
    // 停用不动已有集成文件（避免误删用户改动），仅移除 opencode.json 中的 mcp 注册
    if (!config.enabled) return result;
    for (const file of buildIntegrationFiles(config)) {
      const abs = path.join(projectPath, file.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, file.content, 'utf-8');
      result.files.push(file.path);
    }
  } catch (err) {
    result.ok = false;
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

/** 读取已保存的 AI 工具配置并合并预设，文件缺失时返回 null */
function loadSavedAiToolConfig(): AiToolConfig | null {
  if (!fs.existsSync(AI_TOOL_FILE)) return null;
  const saved = JSON.parse(fs.readFileSync(AI_TOOL_FILE, 'utf-8')) as Partial<AiToolConfig>;
  const preset = AI_TOOL_PRESETS[saved.id ?? ''] ?? AI_TOOL_PRESETS.opencode;
  return { ...preset, ...saved };
}

/** 写入 AI 工具配置文件，返回是否成功 */
function writeAiToolConfig(config: AiToolConfig): boolean {
  try {
    fs.writeFileSync(AI_TOOL_FILE, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('Failed to save ai tool config:', e);
    return false;
  }
}

/** 将集成文件写入多个目标项目（停用也遍历：仅移除 opencode.json 中的 mcp 注册） */
function applyIntegrationToProjects(config: AiToolConfig, projectPaths: string[]): AiProjectWriteResult[] {
  const projects: AiProjectWriteResult[] = [];
  for (const projectPath of projectPaths) {
    if (!projectPath || typeof projectPath !== 'string') continue;
    projects.push(writeAiIntegrationFiles(projectPath, config));
  }
  return projects;
}

/** 从 projects.json 读取有效的项目路径列表 */
function readProjectPaths(): string[] {
  if (!fs.existsSync(PROJECTS_FILE)) return [];
  const projects: unknown = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
  if (!Array.isArray(projects)) return [];
  return projects
    .map((project) =>
      typeof project === 'object' && project !== null && 'path' in project
        ? (project as { path?: unknown }).path
        : undefined,
    )
    .filter((p): p is string => typeof p === 'string' && p !== '');
}

/**
 * 启动时自动补写 AI 工具集成文件（幂等）。
 * 用户此前在旧版本启用过 OpenCode 时，opencode.json 尚未写入；此处在每次启动时
 * 对齐 ai-tool.json 与 projects.json，已启用则补齐集成文件，失败仅告警不阻断启动。
 */
export async function syncAiIntegrationOnStartup(): Promise<void> {
  try {
    const config = loadSavedAiToolConfig();
    if (!config?.enabled) return;
    for (const projectPath of readProjectPaths()) {
      const result = writeAiIntegrationFiles(projectPath, config);
      if (!result.ok) {
        console.warn(`[ai:startup] 集成文件同步失败: ${projectPath}`, result.error ?? '');
      }
    }
  } catch (err) {
    console.warn('[ai:startup] 启动同步 AI 工具配置失败（不影响启动）:', err instanceof Error ? err.message : err);
  }
}

export function registerAiToolsIpc(): void {
  ipcMain.handle('ai:loadConfig', async (): Promise<AiToolConfig> => {
    try {
      return loadSavedAiToolConfig() ?? { ...AI_TOOL_PRESETS.opencode };
    } catch (e) {
      console.error('Failed to load ai tool config:', e);
      return { ...AI_TOOL_PRESETS.opencode };
    }
  });

  ipcMain.handle('ai:saveConfig', async (_event, config: AiToolConfig, projectPaths: string[]): Promise<AiApplyResult> => {
    if (!writeAiToolConfig(config)) {
      return { saved: false, projects: [] };
    }

    const projects = applyIntegrationToProjects(config, projectPaths);
    return { saved: true, projects };
  });
}
