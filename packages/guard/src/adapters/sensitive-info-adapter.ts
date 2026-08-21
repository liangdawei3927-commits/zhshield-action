import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Adapter, CheckConfig, CheckResult, CheckStatus } from '../types';

const SCAN_FILE_EXT = /\.(ts|tsx|js|jsx|yml|yaml|json|md|env|config)$/i;

/**
 * Guard 敏感信息适配器 — L1 门禁
 *
 * 使用正则表达式扫描目标目录中的敏感信息（密钥、Token、密码等）。
 * 无需外部依赖，纯静态分析。
 *
 * P0-3 门禁密钥分域：注入 SecretStateLookup 同步直读 @zh/security 落盘的
 * `.zhshield/secrets-state.json`，rotating/rotated/dismissed 状态豁免放行，
 * active / 未知状态仍拦截（安全域 fail-closed）。
 *
 * 适配器契约:
 * - run(): 扫描目录，返回所有发现（同步）
 * - normalize(): 将发现结果转为 CheckResult（同步）
 */
const DEFAULT_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'API Key/Password/Secret', regex: /(?:api[_-]?key|password|secret|token|credential)\s*[:=]\s*['"]((?:[^'"]|\\['"])+)['"]/i },
  { name: 'AWS Access Key', regex: /(AKIA[0-9A-Z]{16})/ },
  { name: 'OpenAI API Key', regex: /(sk-[a-zA-Z0-9]{32,})/ },
  { name: 'Private Key', regex: /(-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----)/ },
  { name: 'GitHub Token', regex: /(gh[psu]_[a-zA-Z0-9]{36,})/ },
  { name: 'JWT Token', regex: /(eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/ },
];

/** 密钥生命周期状态（与 @zh/security SecretStatus 对齐；guard 侧独立声明，避免引擎互相 import） */
export type SecretLifecycleStatus = 'active' | 'rotating' | 'rotated' | 'dismissed';

/** 密钥状态查询抽象：targetDir 每次调用传入（部分组合根仅构造一次，路径由 run() 提供） */
export interface SecretStateLookup {
  getStatus(secretHash: string, targetDir: string): SecretLifecycleStatus | undefined;
}

type SecretStateMap = Record<string, { status?: string } | undefined>;

/**
 * 文件状态查询 — 同步直读 `.zhshield/secrets-state.json`。
 *
 * @zh/security 的 FileSecretStore 是异步的（fs/promises），而 guard 适配器 run/normalize
 * 为同步契约；且 guard 仅依赖 @zh/shared/@zh/kernel/@zh/i18n，不得 import @zh/security。
 * 因此这里用 node:fs 同步 API 自行读取，按 targetDir 缓存避免每个 finding 重复读盘。
 */
export class FileSecretStateLookup implements SecretStateLookup {
  private cache = new Map<string, SecretStateMap | null>();

  getStatus(secretHash: string, targetDir: string): SecretLifecycleStatus | undefined {
    const state = this.loadState(targetDir);
    if (!state) return undefined;
    const status = state[secretHash]?.status;
    if (status === 'active' || status === 'rotating' || status === 'rotated' || status === 'dismissed') {
      return status;
    }
    return undefined;
  }

  private loadState(targetDir: string): SecretStateMap | null {
    if (this.cache.has(targetDir)) return this.cache.get(targetDir) ?? null;
    let state: SecretStateMap | null = null;
    const statePath = path.join(targetDir, '.zhshield', 'secrets-state.json');
    try {
      if (fs.existsSync(statePath)) {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
          secrets?: Record<string, { status?: string }>;
        };
        state = parsed?.secrets ?? {};
      }
    } catch {
      state = null;
    }
    this.cache.set(targetDir, state);
    return state;
  }
}

interface Finding {
  file: string;
  line: number;
  pattern: string;
  match: string;
  secretHash?: string;
  exempted?: boolean;
}

interface PatternMatch {
  pattern: string;
  value: string;
}

export class GuardSensitiveInfoAdapter implements Adapter {
  private patterns: { name: string; regex: RegExp }[];
  private lastTargetDir = '';

  constructor(
    customPatternsOrLookup?: { name: string; regex: RegExp }[] | SecretStateLookup,
    private stateLookup?: SecretStateLookup,
  ) {
    if (customPatternsOrLookup && !Array.isArray(customPatternsOrLookup)) {
      // 组合根以单参形式注入状态查询：new GuardSensitiveInfoAdapter(new FileSecretStateLookup())
      this.stateLookup = customPatternsOrLookup;
      this.patterns = DEFAULT_PATTERNS;
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
    const dir = context.repoRoot || context.projectPath || process.cwd();
    this.lastTargetDir = dir;
    return dir;
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
    const active = findings.filter((f) => !f.exempted);
    const exempted = findings.filter((f) => f.exempted);

    if (active.length > 0) {
      const details = active.map(
        (f) => `${f.file}:${f.line} 匹配 ${f.pattern}: ${f.match.slice(0, 60)}`,
      );
      return this.makeResult(
        check,
        'failed',
        `发现 ${active.length} 处疑似敏感信息:\n${details.join('\n')}`,
        {
          findings: active,
          count: active.length,
          exempted: this.buildExemptedDetails(exempted),
          exemptedCount: exempted.length,
        },
      );
    }

    if (exempted.length > 0) {
      return this.makeResult(
        check,
        'passed',
        `敏感信息检查通过，${exempted.length} 处处于轮换/已轮换/已豁免状态（rotating/rotated/dismissed）已放行`,
        {
          findings: [],
          count: 0,
          exempted: this.buildExemptedDetails(exempted),
          exemptedCount: exempted.length,
        },
      );
    }

    return this.makeResult(check, 'passed', '敏感信息检查通过，未发现泄露');
  }

  /** 审计记录：豁免发现的 file/line/pattern + 解析出的生命周期状态 */
  private buildExemptedDetails(
    exempted: Finding[],
  ): Array<{ file: string; line: number; pattern: string; status?: SecretLifecycleStatus }> {
    return exempted.map((f) => ({
      file: f.file,
      line: f.line,
      pattern: f.pattern,
      status:
        f.secretHash && this.stateLookup
          ? this.stateLookup.getStatus(f.secretHash, this.lastTargetDir)
          : undefined,
    }));
  }

  private scanDir(
    dir: string,
    findings: Finding[],
    rootDir: string,
  ): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      this.scanEntry(entry, dir, findings, rootDir);
    }
  }

  private scanEntry(
    entry: fs.Dirent,
    dir: string,
    findings: Finding[],
    rootDir: string,
  ): void {
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
    this.scanFileContent(content, path.relative(rootDir, fullPath), findings, rootDir);
  }

  private scanFileContent(content: string, relPath: string, findings: Finding[], targetDir: string): void {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const matched = this.matchPattern(lines[i]);
      if (!matched) continue;
      const secretHash = createHash('sha256').update(matched.value).digest('hex');
      const status = this.stateLookup?.getStatus(secretHash, targetDir);
      const exempted = status === 'rotating' || status === 'rotated' || status === 'dismissed';
      findings.push({
        file: relPath,
        line: i + 1,
        pattern: matched.pattern,
        match: lines[i].trim().slice(0, 80),
        secretHash,
        exempted,
      });
    }
  }

  private matchPattern(line: string): PatternMatch | null {
    for (const pattern of this.patterns) {
      const match = pattern.regex.exec(line);
      if (match) {
        return { pattern: pattern.name, value: match[1] ?? match[0] };
      }
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
