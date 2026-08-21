import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

export interface ToolRule {
  id: string;
  toolId: string;
  name: string;
  content: string;
  format: 'yaml' | 'json' | 'toml';
  filePath: string;
}

/**
 * 从 tool-packs 目录加载工具规则文件
 * 支持 semgrep、trivy、eslint、dep-cruiser 等工具的规则包
 */
export class ToolRuleLoader {
  private packsDir: string;

  constructor(packsDir?: string) {
    this.packsDir = packsDir ?? join(__dirname, '..', '..', 'kernel', 'src', 'sop', 'tool-packs');
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
      .filter(d => d.isDirectory())
      .map(d => d.name);

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

  private walkDirectory(dir: string, toolId: string, rules: ToolRule[]): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      
      if (entry.isDirectory()) {
        this.walkDirectory(fullPath, toolId, rules);
      } else if (this.isRuleFile(entry.name)) {
        const rule = this.loadRuleFile(fullPath, toolId);
        if (rule) rules.push(rule);
      }
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
      console.warn(`[ToolRuleLoader] Failed to load rule file: ${filePath}`, err);
      return null;
    }
  }

  private isRuleFile(filename: string): boolean {
    return /\.(yaml|yml|json|toml)$/.test(filename);
  }

  private extractRuleName(filePath: string): string {
    const basename = filePath.split('/').pop() ?? filePath.split('\\').pop() ?? '';
    return basename.replace(/\.(yaml|yml|json|toml)$/, '');
  }
}
