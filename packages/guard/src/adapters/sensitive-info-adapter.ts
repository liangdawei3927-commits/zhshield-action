import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Adapter, CheckConfig, CheckResult, CheckStatus } from '../types';
import { SECRET_PATTERNS, toNameRegexPatterns } from '@zh/shared';

const SCAN_FILE_EXT = /\.(ts|tsx|js|jsx|yml|yaml|json|md|env|config)$/i;

/**
 * Guard 敏感信息适配器 — L1 门禁
 *
 * 使用正则表达式扫描目标目录中的敏感信息（密钥、Token、密码等）。
 * 无需外部依赖，纯静态分析 —— 门禁必须零外部二进制可跑，装 gitleaks 只是可选项。
 *
 * 口径来源（T8 统一）：模式表取自 `@zh/shared` 的 `SECRET_PATTERNS`，
 * 每一行都用 gitleaks 规则 id 锚定，并与 `guard/block/sensitive-info.yml` 的
 * `standards.gitleaks` 声明保持覆盖关系（由 kernel 的 parity 测试锁定）。
 *
 * 适配器契约:
 * - run(): 扫描目录，返回所有发现（同步）
 * - normalize(): 将发现结果转为 CheckResult（同步）
 *
 * 已知缺口（不掩盖）：本适配器**不消费**用户对密钥告警的驳回记录。此前构造签名
 * 接受一个 FileSecretStateLookup 参数，看起来会豁免已驳回项，实际该字段从未被读取、
 * acknowledge() 也从未被调用——是"接线了却没消费"的空壳。已删除以免继续误导，
 * 驳回态抑制属于安全中心 SecretLifecycleManager 的职责，待立项。
 */
interface Finding {
  file: string;
  line: number;
  pattern: string;
  match: string;
}

export class GuardSensitiveInfoAdapter implements Adapter {
  private patterns: { name: string; regex: RegExp }[];

  constructor(customPatterns?: { name: string; regex: RegExp }[]) {
    this.patterns = customPatterns ?? toNameRegexPatterns(SECRET_PATTERNS);
  }

  run(
    context: { repoRoot?: string; projectPath?: string },
    _check: CheckConfig,
  ): { findings: Finding[]; error?: string } {
    const targetDir = this.resolveTargetDir(context, _check.checkId);
    const findings: Finding[] = [];

    try {
      this.scanProject(targetDir, findings);
    } catch (error: unknown) {
      return { findings: [], error: error instanceof Error ? error.message : String(error) };
    }

    return { findings };
  }

  /** 从上下文解析待扫描的目标目录 */
  private resolveTargetDir(
    context: { repoRoot?: string; projectPath?: string },
    checkId: string,
  ): string {
    const targetDir = context.repoRoot || context.projectPath;
    if (!targetDir)
      throw new Error(`${checkId}: 缺少 projectPath/repoRoot 上下文，无法确定扫描目录`);
    return targetDir;
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

  private scanDir(dir: string, findings: Finding[], rootDir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      this.scanEntry(dir, entry, findings, rootDir);
    }
  }

  /** 扫描单个目录项：目录递归、文件按扩展名过滤 */
  private scanEntry(dir: string, entry: fs.Dirent, findings: Finding[], rootDir: string): void {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (this.isExcludedDir(entry.name)) {
        return;
      }
      this.scanDir(fullPath, findings, rootDir);
      return;
    }

    if (!SCAN_FILE_EXT.test(entry.name)) {
      return;
    }

    this.scanFile(fullPath, rootDir, findings);
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
