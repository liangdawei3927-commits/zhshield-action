/**
 * AI 编程工具集成配置生成（纯函数，无 Electron 依赖，可单测）
 *
 * 协议依据：00-项目文档/01-治理引擎/07-CLI与AI编程工具通信协议.md
 *   - Linter 协议：写入 .zhshield/diagnostics/latest.json，AI 工具监听文件变更
 *   - 集成配置：.zhshield/integration.json（协议 4.4）
 *   - OpenCode：推荐 Linter 协议 + 事件推送（协议 6.1）
 */

import { t } from '@zh/i18n';

export interface AiToolConfig {
  /** 工具 ID（唯一标识） */
  id: string;
  /** 显示名称 */
  name: string;
  /** 是否启用 */
  enabled: boolean;
  /** 通信模式：linter=监听诊断文件 / cli=命令行拉取 */
  mode: 'linter' | 'cli';
  /** 工具侧配置文件相对路径（写入项目根） */
  configFile: string;
}

/** 内置 AI 工具预设（OpenCode + Trae，后续扩展 Cursor / VS Code） */
export const AI_TOOL_PRESETS: Record<string, AiToolConfig> = {
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    enabled: false,
    mode: 'linter',
    configFile: '.opencode/command/zhshield.md',
  },
  trae: {
    id: 'trae',
    name: 'Trae',
    enabled: false,
    mode: 'linter',
    configFile: '.trae/mcp.json',
  },
};

/** 生成 .zhshield/integration.json 内容（协议 4.4） */
export function buildIntegrationJson(config: AiToolConfig): string {
  return JSON.stringify(
    {
      version: '1.0',
      tool: config.id,
      auto_invoke: {
        on_save: true,
        on_commit: true,
        on_file_change: true,
      },
      linter: {
        enabled: true,
        watch_dir: '.zhshield/diagnostics',
        poll_interval_ms: 3000,
      },
      filters: {
        min_severity: 'warning',
        categories: ['security', 'architecture', 'quality'],
      },
      auto_fix: {
        enabled: true,
        max_issues_per_session: 10,
        categories: ['quality'],
      },
    },
    null,
    2,
  );
}

/** 生成 OpenCode 侧命令文件内容（.opencode/command/zhshield.md，协议 6.1 工作流） */
export function buildOpenCodeCommand(): string {
  return [
    '---',
    t('ai.toolConfig.openCodeCommand.description'),
    '---',
    '',
    t('ai.toolConfig.openCodeCommand.title'),
    '',
    t('ai.toolConfig.openCodeCommand.step1'),
    t('ai.toolConfig.openCodeCommand.step2'),
    t('ai.toolConfig.openCodeCommand.step3'),
    t('ai.toolConfig.openCodeCommand.step4'),
    '',
  ].join('\n');
}

/** 工具侧配置文件内容（未知工具返回 null，仅生成协议标准文件） */
export function buildToolConfigFile(config: AiToolConfig): string | null {
  if (config.id === 'opencode') {
    return buildOpenCodeCommand();
  }
  return null;
}

export interface IntegrationFile {
  /** 相对项目根的路径 */
  path: string;
  content: string;
}

/** 待写入项目的集成文件清单 */
export function buildIntegrationFiles(config: AiToolConfig): IntegrationFile[] {
  const files: IntegrationFile[] = [
    { path: '.zhshield/integration.json', content: buildIntegrationJson(config) },
  ];
  const toolFile = buildToolConfigFile(config);
  if (toolFile) {
    files.push({ path: config.configFile, content: toolFile });
  }
  return files;
}

// ─── OpenCode MCP 配置（opencode.json 合并） ───────────────────────────

export interface OpenCodeMcpBlock {
  type: 'local';
  command: string[];
  enabled: boolean;
}

export interface OpenCodeConfigJson {
  $schema: string;
  mcp?: Record<string, unknown>;
}

/** 解析既有 opencode.json（JSONC 注释会被剥离），失败返回 null */
function parseOpenCodeConfig(raw: string | null): Record<string, unknown> | null {
  if (!raw || raw.trim() === '') return {};
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .trim();
  try {
    const parsed: unknown = JSON.parse(stripped);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 合并生成 opencode.json 内容。
 * - 既有配置的键全部保留（OpenCode 配置是合并语义，不能覆盖用户设置）
 * - mcpBlock 非空时写入 mcp.zhshield；为 null 时移除 zhshield（停用）
 * - 既有配置无法解析时返回 null，调用方应跳过写入（避免破坏用户文件）
 */
export function buildOpenCodeConfigJson(existing: string | null, mcpBlock: OpenCodeMcpBlock | null): string | null {
  const base = parseOpenCodeConfig(existing);
  if (base === null) return null;

  const mcp = (base.mcp as Record<string, unknown> | undefined) ?? {};
  if (mcpBlock) {
    mcp.zhshield = mcpBlock;
    base.mcp = mcp;
  } else {
    delete mcp.zhshield;
    if (Object.keys(mcp).length > 0) {
      base.mcp = mcp;
    } else {
      delete base.mcp;
    }
  }

  if (Object.keys(base).length === 0 && !mcpBlock) {
    return JSON.stringify({}, null, 2);
  }
  return JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...base }, null, 2);
}

// ─── Trae MCP 配置（.trae/mcp.json 合并） ──────────────────────────────

export interface TraeMcpServer {
  name: string;
  command: string[];
  env?: Record<string, string>;
}

interface TraeMcpConfigShape {
  mcpServers: TraeMcpServer[];
}

/** 解析既有 .trae/mcp.json 的 mcpServers 数组；失败/不存在返回空数组（不破坏用户文件） */
function parseTraeMcpServers(raw: string | null): TraeMcpServer[] {
  if (!raw || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (!Array.isArray(servers)) return [];
    return servers.filter(
      (s): s is TraeMcpServer =>
        typeof s === 'object' && s !== null && typeof (s as { name?: unknown }).name === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * 合并生成 .trae/mcp.json 内容（合并语义，保留用户其它 server）。
 * - mcpBlock 非空时写入/覆盖 name='zhshield' 的 server
 * - mcpBlock 为 null 时移除 zhshield（停用）
 * - 既有配置无法解析时仍写入 zhshield（不破坏用户文件，因为只是新增）
 */
export function buildTraeMcpJson(existing: string | null, mcpBlock: TraeMcpServer | null): string {
  const servers = parseTraeMcpServers(existing).filter((s) => s.name !== 'zhshield');
  if (mcpBlock) {
    servers.push(mcpBlock);
  }
  const config: TraeMcpConfigShape = { mcpServers: servers };
  return JSON.stringify(config, null, 2);
}
