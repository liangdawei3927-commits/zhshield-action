import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import { sanitizeLogField } from '@zh/shared';

const RULE_FILE_EXT_RE = /\.(yaml|yml|json|toml)$/;

/** 从 tool-packs 目录读出的单条工具规则：来源工具、规则名、原始内容与文件路径 */
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
 *
 * ⚠️ 默认目录自 2026-09-05（`a004661`「C6 删源规则」）起**已不存在**：
 * `packages/kernel/src/sop/tool-packs` 的 94 个规则文件已迁到
 * `packages/kernel/test-fixtures/sop-content/tool-packs`（测试夹具，不是生产来源）。
 *
 * 因此本 loader 的「默认路径」在生产里必然落空，`loadAll()` 返回空——这是**预期行为**，
 * 不是故障：规则的正规来源是数据库（`tool_package` 表），由 `ToolRuleStore.snapshot()`
 * 从 `SopContentRepository` 读取。文件系统只是 DB 不可用时的兜底，而该兜底当前没有
 * 内容可读（`tool-rule-store` 会打一条 warn 后降级为空包）。
 *
 * 不要把默认路径改指 test-fixtures：测试数据不该成为生产兜底来源。
 * 需要恢复文件系统兜底时，应把规则包重新放回一个**生产**目录，再同步改默认路径。
 */
export class ToolRuleLoader {
  private packsDir: string;

  constructor(packsDir?: string) {
    // 默认指向 packages/kernel/src/sop/tool-packs（从 <server>/{src,dist}/sop 上溯三级到 packages/）
    // ⚠️ 该目录已删除（见类注释），此默认值在生产中必然落空 → 空包降级
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
