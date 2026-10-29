import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { depcheckMapper, resolveToolCommandDetailed } from '@zh/shared';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions } from '@zh/shared';
import type { ExecError, DepcheckOutput } from './tool-output-types';

const execFileAsync = promisify(execFile);

const META: ToolMeta = {
  id: 'depcheck',
  name: 'Depcheck',
  category: 'security',
  priority: 'P1',
  installMode: 'builtin',
  description: '未使用依赖检测',
  cliCommand: 'depcheck',
  homepage: 'https://github.com/depcheck/depcheck',
  license: 'MIT',
};

export class DepcheckAdapter implements ToolAdapter {
  meta = META;

  async isAvailable(): Promise<boolean> {
    // 与 InspectEngine / trivy 同一套解析（项目本地 → ~/.zhshield/bin → PATH）：
    // depcheck 装入码盾目录时裸命令只认 PATH 会误报未安装。
    const { origin } = await resolveToolCommandDetailed('depcheck');
    return origin !== 'unresolved';
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();

    // 前置检查：depcheck 以「扫描根是否存在 package.json」为适用前提。缺少该前提时
    // depcheck 会输出 "Path ... does not contain a package.json file" 且非 JSON，
    // 此前经 JSON.parse 抛错落 error 分支，与「工具不可用」混进同一降级横幅（误报）。
    // 与 trivy 侧口径一致：范围外按 skipped 处理，不进 degraded。
    if (!(await this.hasRootPackageJson(options.projectPath))) {
      return {
        tool: 'depcheck',
        status: 'skipped',
        skipReason: 'out-of-scope',
        issues: [],
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: 0,
        },
        error:
          '扫描根目录无 package.json，未使用依赖检测范围外未执行（如需检测请在含 Node 清单的项目根运行）',
      };
    }

    try {
      const output = await this.runDepcheck(options);
      const issues = depcheckMapper(output);

      return {
        tool: 'depcheck',
        status: 'available',
        issues,
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: 0,
        },
      };
    } catch (error) {
      return this.buildErrorResult(start, error as ExecError);
    }
  }

  /** 扫描根是否存在 Node 清单（depcheck 的适用前提） */
  private async hasRootPackageJson(projectPath: string): Promise<boolean> {
    try {
      await fs.promises.access(path.join(path.resolve(projectPath), 'package.json'));
      return true;
    } catch {
      return false;
    }
  }

  private async runDepcheck(options: ToolScanOptions): Promise<DepcheckOutput> {
    let stdout: string;
    try {
      // 归一化 projectPath 为绝对路径：相对路径会作为扫描目标传给 depcheck，
      // depcheck 以自身 cwd 解析导致扫描失败。
      const projectPath = path.resolve(options.projectPath);
      // 统一解析：项目本地 → ~/.zhshield/bin → PATH（裸命令只认 PATH）
      const { command } = await resolveToolCommandDetailed('depcheck', options.projectPath);
      const res = await execFileAsync(command, [projectPath, '--json'], {
        cwd: projectPath,
        timeout: options.timeout || 30000,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = res.stdout;
    } catch (error) {
      // depcheck 检出未使用依赖时以非零码退出但 stdout 仍是合法 JSON（与 inspect 端实测一致）
      const err = error as ExecError;
      if (err.stdout) {
        stdout = err.stdout;
      } else {
        throw error;
      }
    }
    return JSON.parse(stdout);
  }

  private buildErrorResult(start: number, err: ExecError): ToolResult {
    if (err.code === 'ENOENT') {
      return {
        tool: 'depcheck',
        status: 'unavailable',
        issues: [],
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: 0,
        },
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
