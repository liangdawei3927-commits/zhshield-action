import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext } from '../sop/_meta/rule-context';
import type { Violation } from '../sop/_meta/rule-evaluation';

/** 跳过的大文件阈值 (1MB) */
const MAX_FILE_SIZE = 1_048_576;

/**
 * 解析待扫描的文件列表
 */
export function resolveFiles(context: RuleContext, exts?: string[]): string[] {
  if (context.files && context.files.length > 0) {
    return context.files.filter((f) => {
      if (!exts || exts.length === 0) return true;
      return exts.some((e) => f.endsWith(e));
    });
  }

  // 扫描 repo 下的 src/ 目录
  const srcDir = path.join(context.repoRoot, 'src');
  if (!fs.existsSync(srcDir)) return [];

  return collectFiles(srcDir, exts);
}

function collectFiles(dir: string, exts?: string[]): string[] {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // 忽略无权限目录
    return files;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      files.push(...collectFiles(fullPath, exts));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!exts || exts.length === 0 || exts.some((e) => entry.name.endsWith(e))) {
      files.push(fullPath);
    }
  }
  return files;
}

/** 安全读取文件内容：二进制 / 超大文件 (>1MB) 返回 null */
export function readFileSafe(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** 按正则模式扫描单文件内容，返回所有命中违规 */
export function scanPatternsInFile(content: string, relativePath: string, rule: SopRule, patterns: string[]): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');

  for (const patternStr of patterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(patternStr, 'g');
    } catch {
      // 正则无效则跳过
      continue;
    }

    for (let i = 0; i < lines.length; i++) {
      let match: RegExpExecArray | null;
      // Reset lastIndex for each line
      regex.lastIndex = 0;
      while ((match = regex.exec(lines[i])) !== null) {
        violations.push({
          id: randomUUID(),
          ruleId: rule.id,
          severity: rule.severity,
          file: relativePath,
          line: i + 1,
          column: match.index + 1,
          message: `匹配到敏感模式: ${match[0].slice(0, 80)}`,
          suggestion: '移除或使用环境变量替代硬编码值',
          match: match[0].slice(0, 120),
        });
      }
    }
  }

  return violations;
}

/** 扫描单文件内容中的禁止模式（子串匹配），返回所有命中违规 */
export function scanForbiddenInFile(content: string, relativePath: string, rule: SopRule, patterns: string[]): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');

  for (const pattern of patterns) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(pattern)) {
        violations.push({
          id: randomUUID(),
          ruleId: rule.id,
          severity: rule.severity,
          file: relativePath,
          line: i + 1,
          column: lines[i].indexOf(pattern) + 1,
          message: `禁止使用: "${pattern}"`,
          suggestion: `移除或替换 "${pattern}" 为类型安全的替代方案`,
          match: lines[i].trim().slice(0, 120),
        });
      }
    }
  }

  return violations;
}

/** 根据文件路径判断所属层级（按层名匹配目录） */
export function detectLayer(filePath: string, layers: Array<{ name: string; allowedDependencies: string[] }>): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  for (const layer of layers) {
    if (new RegExp(`/${layer.name}/`, 'i').test(normalized)) {
      return layer.name;
    }
  }
  return null;
}

/** 根据导入的模块名判断目标层级 */
export function detectLayerByName(moduleName: string, layers: Array<{ name: string; allowedDependencies: string[] }>): string | null {
  const lower = moduleName.toLowerCase();
  for (const layer of layers) {
    if (lower === layer.name.toLowerCase() || lower.includes(layer.name.toLowerCase())) {
      return layer.name;
    }
  }
  return null;
}
