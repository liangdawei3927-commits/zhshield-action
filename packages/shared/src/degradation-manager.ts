import type { LanguageCode } from '@zh/i18n';
import type { ToolId, DegradationLevel, BuiltinRule, Issue } from './types';
import { buildFallbackRules } from './builtin-rules';

export class DegradationManager {
  private currentLevel: DegradationLevel = 0;
  private readonly coreTools: ToolId[] = ['eslint', 'semgrep'];
  private toolErrors = new Map<ToolId, string>();
  private failureCount = 0;

  getLevel(): DegradationLevel {
    return this.currentLevel;
  }

  setLevel(level: DegradationLevel): void {
    this.currentLevel = level;
  }

  escalate(error: string, tool: ToolId): DegradationLevel {
    this.toolErrors.set(tool, error);
    this.failureCount++;

    if (this.failureCount >= 3 && this.currentLevel < 4) {
      this.currentLevel = Math.min(4, this.currentLevel + 1) as DegradationLevel;
      this.failureCount = 0;
    }

    return this.currentLevel;
  }

  isToolSkipped(tool: ToolId): boolean {
    if (this.currentLevel === 0) return false;
    if (this.currentLevel === 1) return this.toolErrors.has(tool);
    if (this.currentLevel === 2) return !this.coreTools.includes(tool);
    return true; // Level 3 and 4: all tools skipped
  }

  getActiveTools(allTools: ToolId[]): ToolId[] {
    return allTools.filter((t) => !this.isToolSkipped(t));
  }

  reset(): void {
    this.currentLevel = 0;
    this.toolErrors.clear();
    this.failureCount = 0;
  }

  recordToolError(tool: ToolId, error: string): void {
    this.toolErrors.set(tool, error);
    this.failureCount++;
  }

  getToolErrors(): Map<ToolId, string> {
    return new Map(this.toolErrors);
  }

  getFallbackRules(locale?: LanguageCode): BuiltinRule[] {
    if (this.currentLevel < 3) return [];
    return buildFallbackRules(locale);
  }

  getFallbackIssues(projectId: string, locale?: LanguageCode): Issue[] {
    const rules = this.getFallbackRules(locale);
    if (rules.length === 0) return [];

    return rules.map((rule, idx) => ({
      id: `fallback-${idx + 1}-${Date.now()}`,
      ruleId: rule.ruleId,
      severity: rule.severity,
      category: rule.category,
      message: rule.message,
      file: projectId,
      line: 0,
      column: 0,
      suggestion: rule.message,
      autoFixable: false,
      source: 'inspect' as const,
      fingerprint: `fallback-${rule.ruleId}`,
    }));
  }
}
