import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import { sanitizeLogField } from '@zh/shared';

const RULE_FILE_EXT_RE = /\.(yaml|yml|json|toml)$/;

export interface ToolRule {
  id: string;
  toolId: string;
  name: string;
  content: string;
  format: 'yaml' | 'json' | 'toml';
  filePath: string;
}

/** 与远端同步契约一致的规则文件条目（结构兼容 @zh/kernel 的 ToolRuleFile） */
export interface ToolRuleFileEntry {
  filename: string;
  content: string;
}

/**
 * 从 tool-packs 目录加载工具规则文件
 * 支持 semgrep、trivy、eslint、dep-cruiser 等工具的规则包
 */
export class ToolRuleLoader {
  private packsDir: string;

  constructor(packsDir?: string) {
    // 默认指向 packages/kernel/src/sop/tool-packs（从 <server>/{src,dist}/sop 上溯三级到 packages/）
    this.packsDir =
      packsDir ?? join(__dirname, '..', '..', '..', 'kernel', 'src', 'sop', 'tool-packs');
  }

  /**
   * 加载所有工具规则包
   */
  loadAll(): ToolRule[] {
    const rules: ToolRule[] = [];

    if (!existsSync(this.packsDir)) {
      console.warn(`[ToolRuleLoader] Packs directory not found: ${this.packsDir}`);
      return rules;
    }

    const tools = readdirSync(this.packsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const tool of tools) {
      const toolRules = this.loadToolRules(tool);
      rules.push(...toolRules);
    }

    return rules;
  }

  /**
   * 加载指定工具的规则
   */
  loadToolRules(toolId: string): ToolRule[] {
    const toolDir = join(this.packsDir, toolId);
    if (!existsSync(toolDir)) return [];

    const rules: ToolRule[] = [];
    this.walkDirectory(toolDir, toolId, rules);
    return rules;
  }

  /**
   * 加载指定工具的规则包，输出远端同步契约的 {filename, content} 列表。
   * filename 为工具目录下的 POSIX 相对路径（如 rules/backdoor.yaml），
   * 与客户端 extractRules 写盘及 hashToolRuleFiles 的相对路径口径一致。
   * 目录不存在或文件不可读时按 loader 语义优雅降级为空/跳过。
   */
  loadToolRuleFiles(toolId: string): ToolRuleFileEntry[] {
    const toolDir = join(this.packsDir, toolId);
    return this.loadToolRules(toolId)
      .map((rule) => ({
        filename: relative(toolDir, rule.filePath).split(sep).join('/'),
        content: rule.content,
      }))
      .sort((a, b) => a.filename.localeCompare(b.filename));
  }

  private walkDirectory(dir: string, toolId: string, rules: ToolRule[]): void {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        this.walkDirectory(fullPath, toolId, rules);
        continue;
      }
      if (!this.isRuleFile(entry.name)) continue;

      const rule = this.loadRuleFile(fullPath, toolId);
      if (rule) rules.push(rule);
    }
  }

  private loadRuleFile(filePath: string, toolId: string): ToolRule | null {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const ext = extname(filePath).slice(1) as 'yaml' | 'json' | 'toml';

      return {
        id: `${toolId}-${filePath.replace(this.packsDir, '').replace(/[/\\]/g, '-').slice(1)}`,
        toolId,
        name: this.extractRuleName(filePath),
        content,
        format: ext,
        filePath,
      };
    } catch (err) {
      console.warn(
        '[ToolRuleLoader] Failed to load rule file: %s',
        sanitizeLogField(filePath),
        err,
      );
      return null;
    }
  }

  private isRuleFile(filename: string): boolean {
    return RULE_FILE_EXT_RE.test(filename);
  }

  private extractRuleName(filePath: string): string {
    const basename = filePath.split('/').pop() ?? filePath.split('\\').pop() ?? '';
    return basename.replace(RULE_FILE_EXT_RE, '');
  }
}
