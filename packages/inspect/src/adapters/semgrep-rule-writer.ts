import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolScanOptions } from '@zh/shared';

/** 内联规则声明（来自 config.rules，原始声明为 string[]，此处按对象结构访问） */
interface SemgrepRule {
  id?: string;
  severity?: string;
  language?: string;
  languages?: string[];
  pattern?: string;
  patternEither?: string[];
  patternNot?: string[];
  patternRegex?: string;
  message?: string;
  metavariableRegex?: Array<{ metavariable: string; regex: string }>;
}

/** 规范化后用于生成 YAML 的规则 */
interface SemgrepRuleYaml {
  id: string;
  severity: string;
  languages: string[];
  pattern?: string;
  patternEither?: string[];
  patternNot?: string[];
  patternRegex?: string;
  message: string;
  metavariableRegex?: Array<{ metavariable: string; regex: string }>;
}

/**
 * SemgrepRuleWriter — 将内联规则声明写入临时 YAML 配置文件
 */
export class SemgrepRuleWriter {
  async writeInlineRuleConfig(options: ToolScanOptions, targetDir: string): Promise<string | null> {
    const rules = options.config?.rules as unknown as SemgrepRule[] | undefined;
    if (rules && rules.length > 0) {
      return this.writeInlineRules(targetDir, rules);
    }
    return null;
  }

  private async writeInlineRules(targetDir: string, rules: SemgrepRule[]): Promise<string | null> {
    if (rules.length === 0) return null;

    const semgrepRules: SemgrepRuleYaml[] = rules.map((r, i) => ({
      id: r.id || `inline-rule-${i}`,
      severity: (r.severity || 'WARNING').toUpperCase(),
      languages: this.detectLanguages(r),
      pattern: r.pattern,
      patternEither: r.patternEither,
      patternNot: r.patternNot,
      patternRegex: r.patternRegex,
      message: r.message || `Semgrep: ${r.id || `rule-${i}`}`,
      metavariableRegex: r.metavariableRegex,
    }));

    const ruleDir = path.join(targetDir, '.semgrep');
    try {
      await fs.promises.mkdir(ruleDir, { recursive: true });
      const rulePath = path.join(ruleDir, `inline-${Date.now()}.yml`);
      const yamlContent = this.buildRuleYaml(semgrepRules);
      await fs.promises.writeFile(rulePath, yamlContent, 'utf-8');
      return rulePath;
    } catch {
      return null;
    }
  }

  private detectLanguages(rule: SemgrepRule): string[] {
    if (rule.language) return [rule.language];
    if (rule.languages) return rule.languages;
    return ['typescript'];
  }

  private buildRuleYaml(rules: SemgrepRuleYaml[]): string {
    const lines: string[] = ['rules:'];
    for (const r of rules) {
      lines.push(`  - id: ${r.id}`);
      lines.push(`    severity: ${r.severity}`);
      lines.push(`    languages: [${r.languages.join(', ')}]`);
      lines.push(`    message: ${r.message}`);
      this.appendRuleMatch(lines, r);
    }
    return lines.join('\n');
  }

  private appendRuleMatch(lines: string[], r: SemgrepRuleYaml): void {
    if (typeof r.patternRegex === 'string' && r.patternRegex.length > 0) {
      lines.push(`    pattern-regex: ${r.patternRegex}`);
      return;
    }

    if (r.patternEither && r.patternEither.length > 0) {
      lines.push('    patterns:');
      lines.push('      - pattern-either:');
      for (const p of r.patternEither) {
        lines.push('          - pattern: |');
        for (const line of p.split('\n')) lines.push(`              ${line}`);
      }
      this.appendPatternNot(lines, r, '      ');
      this.appendMetavariableRegex(lines, r, '      ');
      return;
    }

    const constrained = (r.metavariableRegex?.length ?? 0) > 0 || (r.patternNot?.length ?? 0) > 0;
    if (constrained) {
      lines.push('    patterns:');
      lines.push('      - pattern: |');
      for (const line of (r.pattern || '').split('\n')) lines.push(`          ${line}`);
      this.appendPatternNot(lines, r, '      ');
      this.appendMetavariableRegex(lines, r, '      ');
      return;
    }

    lines.push('    pattern: |');
    for (const line of (r.pattern || '').split('\n')) lines.push(`      ${line}`);
  }

  private appendPatternNot(lines: string[], r: SemgrepRuleYaml, indent: string): void {
    for (const p of r.patternNot ?? []) {
      lines.push(`${indent}- pattern-not: |`);
      for (const line of p.split('\n')) lines.push(`${indent}    ${line}`);
    }
  }

  private appendMetavariableRegex(lines: string[], r: SemgrepRuleYaml, indent: string): void {
    for (const m of r.metavariableRegex ?? []) {
      lines.push(`${indent}- metavariable-regex:`);
      lines.push(`${indent}    metavariable: ${m.metavariable}`);
      lines.push(`${indent}    regex: ${JSON.stringify(m.regex)}`);
    }
  }
}
