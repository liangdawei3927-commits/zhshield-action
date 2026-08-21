import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Adapter, CheckConfig, CheckResult, CheckStatus } from '../types';
import { FileSecretStateLookup } from '../file-secret-state-lookup';

const SCAN_FILE_EXT = /\.(ts|tsx|js|jsx|yml|yaml|json|md|env|config)$/i;

/**
 * Guard 敏感信息适配器 — L1 门禁
 *
 * 使用正则表达式扫描目标目录中的敏感信息（密钥、Token、密码等）。
 * 无需外部依赖，纯静态分析。
 *
 * 适配器契约:
 * - run(): 扫描目录，返回所有发现（同步）
 * - normalize(): 将发现结果转为 CheckResult（同步）
 */
const DEFAULT_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'API Key/Password/Secret', regex: /(?:api[_-]?key|password|secret|token|credential)\s*[:=]\s*['"][^'"]+['"]/i },
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'OpenAI API Key', regex: /sk-[a-zA-Z0-9]{32,}/ },
  { name: 'Private Key', regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/ },
  { name: 'GitHub Token', regex: /gh[psu]_[a-zA-Z0-9]{36,}/ },
  { name: 'JWT Token', regex: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/ },
];

interface Finding {
  file: string;
  line: number;
  pattern: string;
  match: string;
}

export class GuardSensitiveInfoAdapter implements Adapter {
  private patterns: { name: string; regex: RegExp }[];
  private secretStateLookup?: FileSecretStateLookup;

  constructor(customPatternsOrLookup?: { name: string; regex: RegExp }[] | FileSecretStateLookup) {
    if (customPatternsOrLookup instanceof FileSecretStateLookup) {
      this.patterns = DEFAULT_PATTERNS;
      this.secretStateLookup = customPatternsOrLookup;
    } else {
      this.patterns = customPatternsOrLookup ?? DEFAULT_PATTERNS;
    }
  }

  run(
    context: { repoRoot?: string; projectPath?: string },
    _check: CheckConfig,
  ): { findings: Finding[]; error?: string } {
    const targetDir = this.resolveTargetDir(context);
    const findings: Finding[] = [];

    try {
      this.scanProject(targetDir, findings);
    } catch (error: unknown) {
      return { findings: [], error: error instanceof Error ? error.message : String(error) };
    }

    return { findings };
  }

  /** 从上下文解析待扫描的目标目录 */
  private resolveTargetDir(context: { repoRoot?: string; projectPath?: string }): string {
    return context.repoRoot || context.projectPath || process.cwd();
  }

  /** 扫描项目 src 目录（不存在时跳过） */
  private scanProject(targetDir: string, findings: Finding[]): void {
    const srcDir = path.join(targetDir, 'src');
    if (!fs.existsSync(srcDir)) {
      return;
    }
    this.scanDir(srcDir, findings, targetDir);
  }

  normalize(
    rawResult: { findings: Finding[]; error?: string },
    context: unknown,
    check: CheckConfig,
  ): CheckResult {
    if (rawResult.error) {
      return this.makeResult(check, 'error', `敏感信息扫描失败: ${rawResult.error}`);
    }

    const findings = rawResult.findings;
    if (findings.length > 0) {
      const details = findings.map(
        (f) => `${f.file}:${f.line} 匹配 ${f.pattern}: ${f.match.slice(0, 60)}`,
      );
      return this.makeResult(
        check,
        'failed',
        `发现 ${findings.length} 处疑似敏感信息:\n${details.join('\n')}`,
        { findings, count: findings.length },
      );
    }

    return this.makeResult(check, 'passed', '敏感信息检查通过，未发现泄露');
  }

  private scanDir(
    dir: string,
    findings: Finding[],
    rootDir: string,
  ): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (this.isExcludedDir(entry.name)) {
          continue;
        }
        this.scanDir(fullPath, findings, rootDir);
        continue;
      }

      if (!SCAN_FILE_EXT.test(entry.name)) {
        continue;
      }

      this.scanFile(fullPath, rootDir, findings);
    }
  }

  /** 判断目录是否被排除（依赖/构建产物/隐藏目录） */
  private isExcludedDir(name: string): boolean {
    return name === 'node_modules' || name === 'dist' || name === '.git' || name.startsWith('.');
  }

  /** 读取并扫描单个文件内容 */
  private scanFile(fullPath: string, rootDir: string, findings: Finding[]): void {
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      return;
    }
    this.scanFileContent(content, path.relative(rootDir, fullPath), findings);
  }

  private scanFileContent(content: string, relPath: string, findings: Finding[]): void {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const patternName = this.findPatternMatch(lines[i]);
      if (!patternName) continue;
      findings.push({
        file: relPath,
        line: i + 1,
        pattern: patternName,
        match: lines[i].trim().slice(0, 80),
      });
    }
  }

  private findPatternMatch(line: string): string | null {
    for (const pattern of this.patterns) {
      if (pattern.regex.test(line)) return pattern.name;
    }
    return null;
  }

  private makeResult(
    check: CheckConfig,
    status: CheckStatus,
    message: string,
    details?: unknown,
  ): CheckResult {
    return {
      checkId: check.checkId,
      adapter: check.adapter,
      status,
      severity: status === 'failed' || status === 'error' ? check.severity : 'info',
      blocking: check.blocking && (status === 'failed' || status === 'error'),
      message,
      details,
    };
  }
}
