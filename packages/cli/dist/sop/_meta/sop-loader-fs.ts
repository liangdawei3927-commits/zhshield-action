import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SopRule, GovernanceDomain, ActionType } from './sop-types';
import { SopRuleParser } from './sop-loader-parser';

const RULE_FILE_EXT = /\.(yml|yaml|json)$/i;

/** 六大治理域目录 — collectRulesFromTree 只扫描这些一级目录，
 *  presets / tool-packs / cache / sync 等非域目录不作为规则来源加载 */
const GOVERNANCE_DOMAIN_DIRS = new Set<string>([
  'guard',
  'inspect',
  'security',
  'sentinel',
  'evolve',
  'refactor',
]);

/**
 * SOP 规则文件收集器 — 遍历文件系统目录树，收集并解析规则文件
 *
 * 职责：
 * 1. 按 {dir}/{domain}/{action}/ 结构遍历治理域目录
 * 2. 递归收集目录下所有规则文件（支持子目录）
 * 3. 委托 SopRuleParser 解析每个文件为 SopRule
 */
export class SopRuleFileCollector {
  private parser: SopRuleParser;

  constructor(parser: SopRuleParser) {
    this.parser = parser;
  }

  async collectRulesFromTree(dir: string): Promise<SopRule[]> {
    const rules: SopRule[] = [];
    const domainDirs = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const dirent of domainDirs) {
      if (!dirent.isDirectory() || dirent.name.startsWith('_') || dirent.name.startsWith('.')) {
        continue;
      }
      if (dirent.name === 'node_modules') {
        continue;
      }
      if (!GOVERNANCE_DOMAIN_DIRS.has(dirent.name)) {
        continue;
      }
      const domain = dirent.name as GovernanceDomain;
      const domainPath = path.join(dir, domain);
      // eslint-disable-next-line perf/perf-no-serial-await -- arg depends on loop var via dataflow
      const actionDirs = await fs.promises.readdir(domainPath, { withFileTypes: true });
      const actionPromises: Promise<void>[] = [];
      for (const actionDirent of actionDirs) {
        if (!actionDirent.isDirectory() || actionDirent.name.startsWith('.')) continue;
        const action = actionDirent.name as ActionType;
        actionPromises.push(
          this.collectRulesFromAction(path.join(domainPath, action), domain, action, rules),
        );
      }
      // eslint-disable-next-line perf/perf-no-serial-await -- actionPromises depend on loop var via domainPath
      await Promise.all(actionPromises);
    }
    return rules;
  }

  private async collectRulesFromAction(
    actionPath: string,
    domain: GovernanceDomain,
    action: ActionType,
    rules: SopRule[],
  ): Promise<void> {
    for (const filePath of this.collectRuleFiles(actionPath)) {
      const rule = await this.parser.parseRuleFile(filePath, domain, action);
      if (!rule) continue;
      rules.push(rule);
    }
  }

  /** 收集目录下所有规则文件（递归支持子目录如 inspect/scan/typescript/） */
  private collectRuleFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return this.collectRuleFiles(fullPath);
      }
      if (entry.isFile() && RULE_FILE_EXT.test(entry.name)) {
        return [fullPath];
      }
      return [];
    });
  }
}
