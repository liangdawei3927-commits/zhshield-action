import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue } from '@zh/shared';

const execFileAsync = promisify(execFile);

const META: ToolMeta = {
  id: 'depcheck',
  name: 'Depcheck',
  category: 'inspect',
  priority: 'P1',
  installMode: 'builtin',
  description: '未使用依赖检测',
  cliCommand: 'depcheck',
  homepage: 'https://github.com/depcheck/depcheck',
  license: 'MIT',
};

interface DepcheckResult {
  dependencies: string[];
  devDependencies: string[];
  missing: Record<string, string[]>;
  using: Record<string, string[]>;
}

export class DepcheckAdapter implements ToolAdapter {
  meta = META;

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('depcheck', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const projectPath = options.projectPath;

    try {
      const args = [projectPath, '--json'];
      const cfg = options.config as Record<string, unknown> | undefined;
      if (cfg?.skip) {
        for (const s of cfg.skip as string[]) args.push('--skip', s);
      }
      if (cfg?.ignore) {
        for (const ig of cfg.ignore as string[]) args.push('--ignore', ig);
      }

      const { stdout } = await execFileAsync('depcheck', args, {
        cwd: projectPath,
        timeout: options.timeout || 60000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const result: DepcheckResult = JSON.parse(stdout);
      const issues = this.mapOutput(result, projectPath);

      return {
        tool: 'depcheck',
        status: 'available',
        issues,
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: issues.length,
        },
      };
    } catch (error: unknown) {
      const err = error as { code?: string; stderr?: string; message?: string };
      if (err.code === 'ENOENT') {
        return {
          tool: 'depcheck',
          status: 'unavailable',
          issues: [],
          metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
          error: 'depcheck 未安装',
        };
      }
      return {
        tool: 'depcheck',
        status: 'error',
        issues: [],
        metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
        error: err.stderr || err.message || 'depcheck 执行失败',
      };
    }
  }

  private mapOutput(result: DepcheckResult, projectPath: string): Issue[] {
    const issues: Issue[] = [];
    const relPkgJson = path.relative(projectPath, path.join(projectPath, 'package.json')) || 'package.json';

    for (const dep of result.dependencies || []) {
      issues.push({
        id: randomUUID(),
        ruleId: 'depcheck/unused-dependency',
        severity: 'warning',
        category: 'dependency',
        message: `未使用的依赖: ${dep}`,
        file: relPkgJson,
        line: 0,
        column: 0,
        suggestion: `运行 npm uninstall ${dep} 移除未使用的依赖`,
        autoFixable: false,
        source: 'inspect',
        fingerprint: `depcheck:unused:${dep}`,
      });
    }

    for (const dep of result.devDependencies || []) {
      issues.push({
        id: randomUUID(),
        ruleId: 'depcheck/unused-dev-dependency',
        severity: 'info',
        category: 'dependency',
        message: `未使用的 dev 依赖: ${dep}`,
        file: relPkgJson,
        line: 0,
        column: 0,
        suggestion: `将 ${dep} 移入 dependencies 或运行 npm uninstall -D ${dep}`,
        autoFixable: false,
        source: 'inspect',
        fingerprint: `depcheck:unused-dev:${dep}`,
      });
    }

    return issues;
  }
}
