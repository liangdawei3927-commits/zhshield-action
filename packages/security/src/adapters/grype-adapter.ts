import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue } from '@zh/shared';
import { grypeMapper, resolveToolCommandDetailed } from '@zh/shared';
import type { ExecError, GrypeOutput } from './tool-output-types';

const execFileAsync = promisify(execFile);

const META: ToolMeta = {
  id: 'grype',
  name: 'Grype',
  category: 'security',
  priority: 'P1',
  installMode: 'on-demand',
  description: '依赖漏洞交叉复核',
  cliCommand: 'grype',
  homepage: 'https://github.com/anchore/grype',
  license: 'Apache-2.0',
};

export class GrypeAdapter implements ToolAdapter {
  meta = META;

  async isAvailable(): Promise<boolean> {
    // 与 InspectEngine / trivy / semgrep 同一套解析（项目本地 → ~/.zhshield/bin → PATH）：
    // grype 由 install-tools 装入码盾目录，裸命令只认 PATH 会误报未安装。
    const { origin } = await resolveToolCommandDetailed('grype');
    return origin !== 'unresolved';
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();

    try {
      const source = this.resolveScanSource(options);
      const output = await this.runGrype(source, options);
      const issues = this.mapOutput(output);

      return {
        tool: 'grype',
        status: 'available',
        issues,
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: output?.matches?.length || 0,
        },
      };
    } catch (error) {
      return this.buildErrorResult(start, error as ExecError);
    }
  }

  private resolveScanSource(options: ToolScanOptions): string {
    // 支持 docker 镜像扫描：config.rules[0] 作为镜像名，否则扫描目录
    // 归一化 projectPath 为绝对路径：相对路径会作为 dir:<path> 目标传给 grype，
    // grype 以自身 cwd 解析导致扫描失败。
    return options.config?.rules?.[0]
      ? options.config.rules[0]
      : `dir:${path.resolve(options.projectPath)}`;
  }

  private async runGrype(source: string, options: ToolScanOptions): Promise<GrypeOutput> {
    // 统一解析：项目本地 → ~/.zhshield/bin → PATH（裸命令只认 PATH）
    const { command } = await resolveToolCommandDetailed('grype', options.projectPath);
    const { stdout } = await execFileAsync(command, [source, '-o', 'json'], {
      cwd: path.resolve(options.projectPath),
      timeout: options.timeout || 120000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  }

  private buildErrorResult(start: number, err: ExecError): ToolResult {
    if (err.code === 'ENOENT') {
      return {
        tool: 'grype',
        status: 'unavailable',
        issues: [],
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: 0,
        },
        error: 'Grype 未安装（项目本地 node_modules/.bin、~/.zhshield/bin、PATH 均未找到），可在工具面板引导安装',
      };
    }
    const partialIssues = this.parsePartialOutput(err.stdout);
    if (partialIssues) {
      return {
        tool: 'grype',
        status: 'available',
        issues: partialIssues,
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: partialIssues.length,
        },
      };
    }
    return {
      tool: 'grype',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error: err.stderr || err.message || 'Grype 执行失败',
    };
  }

  private parsePartialOutput(stdout: string | undefined): Issue[] | null {
    if (!stdout) return null;
    try {
      const output = JSON.parse(stdout);
      if (Array.isArray(output?.matches)) {
        return this.mapOutput(output);
      }
    } catch {
      // 部分输出可能不是合法 JSON
    }
    return null;
  }

  private mapOutput(output: GrypeOutput): Issue[] {
    return grypeMapper(output);
  }
}
