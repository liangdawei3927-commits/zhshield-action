import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { hashToolRuleFiles, type ToolRuleFile } from '@zh/kernel';
import { SERVER_TOOL_IDS } from '@zh/shared';
import { ToolRuleLoader } from './tool-rule-loader';
import { SopContentRepository } from './sop-content.repository';

export { SERVER_TOOL_IDS };

const VALID_TOOLS = SERVER_TOOL_IDS;

type ToolName = (typeof VALID_TOOLS)[number];

export interface ToolRuleVersion {
  toolId: ToolName;
  version: string;
  hash: string;
  size: number;
  publishedAt: string;
}

/** 版本号由内容哈希派生：规则包文件一旦变更，version 随之变化，客户端才能检测到更新并重新拉取 */
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

/**
 * ToolRuleStore — 工具规则包内存快照（C3/C4 读路径）
 *
 * 单一实例由 ToolRuleController（HTTP 路由）与 AdminService（写路径刷新）共享，
 * 保证 reloadFromRepository() 后 /version 与 /download 立即看到同一份内容。
 */
@Injectable()
export class ToolRuleStore {
  private readonly logger = new Logger(ToolRuleStore.name);
  private packs!: Record<string, ToolRuleFile[]>;
  private versions!: Record<string, ToolRuleVersion>;
  private toolIds!: ReadonlySet<string>;
  private readonly ruleLoader: ToolRuleLoader;
  private readonly repository?: SopContentRepository;

  constructor(ruleLoader: ToolRuleLoader, repository?: SopContentRepository) {
    this.ruleLoader = ruleLoader;
    this.repository = repository;
    this.snapshot();
  }

  /** 构造/管理写路径后调用：一次性快照，保证 /version 与 /download 看到同一份内容，避免客户端哈希校验竞态 */
  private snapshot(): void {
    const rows = this.repository?.listActiveToolPacks() ?? null;
    if (rows && rows.length > 0) {
      this.packs = Object.fromEntries(rows.map((row) => [row.toolId, row.files]));
      this.versions = Object.fromEntries(
        rows.map((row) => [row.toolId, buildVersion(row.toolId as ToolName, row.files)]),
      );
      this.toolIds = new Set(rows.map((row) => row.toolId));
      this.logger.log(
        `Tool packs served from content repository: ${rows.map((r) => r.toolId).join(',')}`,
      );
      return;
    }
    let packs: Record<string, ToolRuleFile[]>;
    try {
      packs = Object.fromEntries(
        VALID_TOOLS.map((toolId) => [toolId, this.ruleLoader.loadToolRuleFiles(toolId)]),
      ) as Record<string, ToolRuleFile[]>;
    } catch (err) {
      // 文件系统兜底不可用（如 tool-packs 已删除）时安全降级为空包，不崩构造
      this.logger.warn(`Tool packs filesystem fallback unavailable: ${String(err)}`);
      packs = Object.fromEntries(VALID_TOOLS.map((toolId) => [toolId, []])) as Record<
        string,
        ToolRuleFile[]
      >;
    }
    if (Object.values(packs).every((files) => files.length === 0)) {
      this.logger.warn('Tool packs filesystem fallback is empty（tool-packs 缺失或为空），降级为空包');
    }
    this.packs = packs;
    this.versions = Object.fromEntries(
      VALID_TOOLS.map((toolId) => [toolId, buildVersion(toolId, this.packs[toolId])]),
    ) as Record<string, ToolRuleVersion>;
    this.toolIds = new Set<string>(VALID_TOOLS);
  }

  /** C4 管理写路径完成后调用：从内容仓库重新快照工具包（读路径立即生效） */
  reloadFromRepository(): void {
    this.snapshot();
  }

  getVersion(tool: string): ToolRuleVersion {
    const t = this.resolveTool(tool);
    return this.versions[t];
  }

  getRules(tool: string): ToolRuleFile[] {
    const t = this.resolveTool(tool);
    const { version, hash } = this.versions[t];
    this.logger.debug(
      `Serving rule pack tool=${t} version=${version} hash=${hash} files=${this.packs[t].length}`,
    );
    return this.packs[t];
  }

  private resolveTool(tool: string): string {
    const normalized = tool.toLowerCase();
    if (!this.toolIds.has(normalized)) {
      throw new NotFoundException(`Unknown tool: ${tool}`);
    }
    return normalized;
  }
}