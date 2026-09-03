/**
 * SonarwayToolAdapter — 用内置 Sonarjs 规则集做 bug 检测的 inspect ToolAdapter。
 *
 * 实现 @zh/shared 的 ToolAdapter 接口，供 SOP 引擎 tool-dispatch 使用。
 * 运行方式：ESLint Node API + 内置 flat config（eslint-plugin-sonarjs，S 系高置信度规则），
 * 不依赖被检项目自身的 ESLint 配置。
 *
 * 性能：默认扫描目标用 resolveEslintTargetDir（与 inspect ESLintAdapter 一致），
 * 并在 flat config 中 ignores 掉 node_modules / dist / 构建产物 / .git，
 * 避免在无 src 的 monorepo 根上扫描全仓（含 759MB node_modules）导致分钟级阻塞。
 */
import { ESLint } from 'eslint';
import { randomUUID } from 'node:crypto';
import {
  resolveEslintTargetDir,
  type ToolAdapter,
  type ToolMeta,
  type ToolResult,
  type ToolScanOptions,
} from '@zh/shared';
import { buildSonarwayConfig } from '@zh/guard';

const META: ToolMeta = {
  id: 'sonarway',
  name: 'SonarWay Bug',
  category: 'inspect',
  priority: 'P1',
  installMode: 'builtin',
  description: 'SonarWay 内置 bug 检测（eslint-plugin-sonarjs，S 系高置信度规则）',
  cliCommand: 'eslint (sonarjs)',
  homepage: 'https://github.com/SonarSource/eslint-plugin-sonarjs',
  license: 'LGPL-3.0',
};

/** ESLint Node API 输出的单条消息 */
interface LintMessage {
  ruleId?: string;
  message?: string;
  line?: number;
  column?: number;
  severity?: number;
  fatal?: boolean;
}

/** ESLint Node API 输出的单个文件项 */
interface LintResult {
  filePath: string;
  messages: LintMessage[];
}

/** 永不扫描的构建/元数据目录（与 inspect 适配器一致的性能边界） */
const IGNORED_DIRS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/dist-electron/**',
  '**/.git/**',
  '**/.zhshield/**',
  '**/build/**',
  '**/.next/**',
  '**/.turbo/**',
];

export class SonarwayToolAdapter implements ToolAdapter {
  meta = META;

  async isAvailable(): Promise<boolean> {
    return typeof ESLint === 'function';
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const { projectPath, targetFiles } = options;

    try {
      const target = targetFiles?.length ? targetFiles : resolveEslintTargetDir(projectPath);
      const config = this.withIgnores();
      const eslint = new ESLint({
        cwd: projectPath,
        overrideConfigFile: true,
        overrideConfig: config as never,
      });

      const results = (await eslint.lintFiles(target)) as unknown as LintResult[];
      const issues = this.toIssues(results);

      return {
        tool: 'sonarway',
        status: 'available',
        issues,
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: results.length,
        },
      };
    } catch (error: unknown) {
      return {
        tool: 'sonarway',
        status: 'error',
        issues: [],
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: 0,
        },
        error: (error as Error)?.message || 'SonarWay/ESLint 执行失败',
      };
    }
  }

  /** 在 sonarway 规则 config 前追加 ignores 边界（ignores 对象必须是数组首项） */
  private withIgnores(): unknown[] {
    return [{ ignores: IGNORED_DIRS }, ...buildSonarwayConfig()];
  }

  /** 将 ESLint LintResult 转换为 ToolAdapter Issue[] */
  private toIssues(results: LintResult[]): ToolResult['issues'] {
    const issues: ToolResult['issues'] = [];
    for (const file of results) {
      if (!file.messages?.length) continue;
      for (const msg of file.messages) {
        if (!msg.ruleId) continue;
        if (msg.message?.includes('Definition for rule')) continue;
        const severity = msg.severity === 2 ? 'error' : 'warning';
        issues.push({
          id: randomUUID(),
          ruleId: `sonarjs/${msg.ruleId}`,
          severity,
          category: 'quality',
          message: msg.message || '',
          file: file.filePath,
          line: msg.line,
          column: msg.column,
          autoFixable: false,
          source: 'inspect',
          fingerprint: `sonarway:${file.filePath}:${msg.line}:${msg.column}:${msg.ruleId}`,
        });
      }
    }
    return issues;
  }
}
