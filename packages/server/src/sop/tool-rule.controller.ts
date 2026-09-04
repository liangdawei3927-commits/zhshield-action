import {
  Controller,
  Get,
  Param,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { hashToolRuleFiles, type ToolRuleFile } from '@zh/kernel';
import { ToolRuleLoader } from './tool-rule-loader';

const VALID_TOOLS = ['semgrep', 'trivy', 'eslint', 'dep-cruiser'] as const;

/** 服务端可下发的工具全集（M3 resolve/tools 的裁剪输入域） */
export const SERVER_TOOL_IDS: readonly string[] = VALID_TOOLS;

type ToolName = (typeof VALID_TOOLS)[number];

const VALID_TOOL_SET: ReadonlySet<string> = new Set<string>(VALID_TOOLS);

function isToolName(value: string): value is ToolName {
  return VALID_TOOL_SET.has(value);
}

interface ToolRuleVersion {
  toolId: ToolName;
  version: string;
  hash: string;
  size: number;
  publishedAt: string;
}

/**
 * 版本号由内容哈希派生：规则包文件一旦变更，version 随之变化，
 * 客户端（ToolRuleSync 按 version 相等短路）才能检测到更新并重新拉取。
 */
function deriveVersion(hash: string): string {
  return `1.${hash.slice(0, 12)}`;
}

function buildVersion(toolId: ToolName, files: ToolRuleFile[]): ToolRuleVersion {
  const hash = hashToolRuleFiles(files);
  return {
    toolId,
    version: deriveVersion(hash),
    hash,
    size: Buffer.byteLength(JSON.stringify(files), 'utf-8'),
    publishedAt: '2026-07-31T00:00:00.000Z',
  };
}

@ApiTags('rules')
@Controller('rules')
export class ToolRuleController {
  private readonly logger = new Logger(ToolRuleController.name);
  private readonly packs: Record<ToolName, ToolRuleFile[]>;
  private readonly versions: Record<ToolName, ToolRuleVersion>;

  constructor(ruleLoader: ToolRuleLoader) {
    // 构造时一次性快照：保证 /version 与 /download 看到同一份内容，避免客户端哈希校验竞态。
    // 规则包文件变更后需重启服务生效。
    this.packs = Object.fromEntries(
      VALID_TOOLS.map((toolId) => [toolId, ruleLoader.loadToolRuleFiles(toolId)]),
    ) as Record<ToolName, ToolRuleFile[]>;
    this.versions = Object.fromEntries(
      VALID_TOOLS.map((toolId) => [toolId, buildVersion(toolId, this.packs[toolId])]),
    ) as Record<ToolName, ToolRuleVersion>;
  }

  @Get(':tool/version')
  @HttpCode(HttpStatus.OK)
  getVersion(@Param('tool') tool: string): ToolRuleVersion {
    const t = this.resolveTool(tool);
    return this.versions[t];
  }

  @Get(':tool/download')
  @HttpCode(HttpStatus.OK)
  getRules(@Param('tool') tool: string): ToolRuleFile[] {
    const t = this.resolveTool(tool);
    const { version, hash } = this.versions[t];
    this.logger.debug(
      `Serving rule pack tool=${t} version=${version} hash=${hash} files=${this.packs[t].length}`,
    );
    return this.packs[t];
  }

  @Get(':tool/emergency')
  @HttpCode(HttpStatus.OK)
  getEmergency(@Param('tool') tool: string): ToolRuleFile[] {
    // TODO(rules-remote): once the remote rule registry ships (tier-3 sync),
    // fetch dedicated emergency packs from it instead of mirroring the static
    // local pack. The local tool-packs remain the offline desktop fallback.
    this.logger.warn(
      `Emergency rule pack requested for ${tool}: serving static local pack (identical to regular rules)`,
    );
    return this.getRules(tool);
  }

  private resolveTool(tool: string): ToolName {
    const normalized = tool.toLowerCase();
    if (!isToolName(normalized)) {
      throw new NotFoundException(`Unknown tool: ${tool}`);
    }
    return normalized;
  }
}
