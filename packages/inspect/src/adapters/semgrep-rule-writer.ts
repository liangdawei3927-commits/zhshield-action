import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolScanOptions } from '@zh/shared';

/** 内联规则临时目录前缀（位于 os.tmpdir() 下，不写入被测项目） */
const INLINE_RULE_TMP_PREFIX = 'zhshield-semgrep-';

/**
 * patterns 复合结构中的单条子表达式。
 * 缓存规则 JSON 以 kebab-case 键声明（pattern-not / metavariable-regex / pattern-either），
 * SOP 内联声明使用 camelCase——两种键同时声明并在规范化时归一到 camelCase。
 */
interface SemgrepPatternEntry {
  pattern?: string;
  patternEither?: string[];
  patternNot?: string;
  patternRegex?: string;
  metavariableRegex?: { metavariable: string; regex: string };
  'pattern-either'?: string[];
  'pattern-not'?: string;
  'pattern-regex'?: string;
  'metavariable-regex'?: { metavariable: string; regex: string };
}

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
  patterns?: SemgrepPatternEntry[];
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
  patterns?: SemgrepPatternEntry[];
}

/** 将 kebab-case / camelCase 声明归一为 camelCase */
function normalizePatternEntry(entry: SemgrepPatternEntry): SemgrepPatternEntry {
  return {
    pattern: entry.pattern,
    patternEither: entry.patternEither ?? entry['pattern-either'],
    patternNot: entry.patternNot ?? entry['pattern-not'],
    patternRegex: entry.patternRegex ?? entry['pattern-regex'],
    metavariableRegex: entry.metavariableRegex ?? entry['metavariable-regex'],
  };
}

/**
 * SemgrepRuleWriter — 将内联规则声明写入临时 YAML 配置文件
 *
 * 规则文件写在 `os.tmpdir()` 下的一次性目录里，**不写进被测项目**：
 * 早先写入 `<项目>/.semgrep/inline-*.yml` 且从不清理，实测残留 5+ 个，
 * 既污染用户仓库（会出现在 git status 里），又因同源内容互相重复
 * 逼得 jscpd 适配器专门加 `.semgrep` 目录排除来躲重复代码误报。
 * 调用方在扫描结束（含失败）后应调用 removeInlineRuleFile 清理。
 */
export class SemgrepRuleWriter {
  async writeInlineRuleConfig(options: ToolScanOptions): Promise<string | null> {
    const rules = options.config?.rules as unknown as SemgrepRule[] | undefined;
    if (rules && rules.length > 0) {
      return this.writeInlineRules(rules);
    }
    return null;
  }

  private async writeInlineRules(rules: SemgrepRule[]): Promise<string | null> {
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
      patterns: r.patterns?.map(normalizePatternEntry),
    }));

    try {
      // mkdtemp 保证目录唯一（并发/连续扫描互不覆盖），路径为绝对路径，
      // 供 semgrep --config 直接消费。
      const ruleDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), INLINE_RULE_TMP_PREFIX),
      );
      const rulePath = path.join(ruleDir, 'inline-rules.yml');
      await fs.promises.writeFile(rulePath, this.buildRuleYaml(semgrepRules), 'utf-8');
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
      // id/severity/message 必须 YAML 引号包裹：message 常含 ': '（如 "Semgrep: <id>"、URL 协议），
      // 裸标量会触发 "mapping values are not allowed here" 解析错误。
      lines.push(`  - id: ${JSON.stringify(r.id)}`);
      lines.push(`    severity: ${JSON.stringify(r.severity)}`);
      lines.push(`    languages: [${r.languages.join(', ')}]`);
      lines.push(`    message: ${JSON.stringify(r.message)}`);
      this.appendRuleMatch(lines, r);
    }
    return lines.join('\n');
  }

  private appendRuleMatch(lines: string[], r: SemgrepRuleYaml): void {
    if (r.patterns && r.patterns.length > 0) {
      lines.push('    patterns:');
      for (const p of r.patterns) {
        if (typeof p.pattern === 'string' && p.pattern.length > 0) {
          lines.push('      - pattern: |');
          for (const line of p.pattern.split('\n')) lines.push(`          ${line}`);
        } else if (p.patternEither && p.patternEither.length > 0) {
          lines.push('      - pattern-either:');
          for (const pe of p.patternEither) {
            lines.push('          - pattern: |');
            for (const line of pe.split('\n')) lines.push(`              ${line}`);
          }
        }
        if (typeof p.patternNot === 'string' && p.patternNot.length > 0) {
          lines.push('      - pattern-not: |');
          for (const line of p.patternNot.split('\n')) lines.push(`          ${line}`);
        }
        if (typeof p.patternRegex === 'string' && p.patternRegex.length > 0) {
          lines.push(`      - pattern-regex: ${JSON.stringify(p.patternRegex)}`);
        }
        if (p.metavariableRegex) {
          lines.push('      - metavariable-regex:');
          lines.push(`          metavariable: ${JSON.stringify(p.metavariableRegex.metavariable)}`);
          lines.push(`          regex: ${JSON.stringify(p.metavariableRegex.regex)}`);
        }
      }
      return;
    }

    if (typeof r.patternRegex === 'string' && r.patternRegex.length > 0) {
      lines.push(`    pattern-regex: ${JSON.stringify(r.patternRegex)}`);
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
      lines.push(`${indent}    metavariable: ${JSON.stringify(m.metavariable)}`);
      lines.push(`${indent}    regex: ${JSON.stringify(m.regex)}`);
    }
  }
}

/**
 * 清理 writeInlineRuleConfig 产生的一次性规则目录。
 *
 * 删除的是 mkdtemp 建出来的独立目录（内含单个 inline-rules.yml），
 * 不会碰到被测项目里的任何文件。清理失败不影响扫描结论，静默忽略。
 */
export async function removeInlineRuleFile(rulePath: string | null | undefined): Promise<void> {
  if (!rulePath) return;
  try {
    await fs.promises.rm(path.dirname(rulePath), { recursive: true, force: true });
  } catch {
    // 清理失败（权限/已被回收）不应影响扫描结果
  }
}
