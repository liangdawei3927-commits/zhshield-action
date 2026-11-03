import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue } from '@zh/shared';
import { grypeMapper, resolveToolCommandDetailed, runToolOnce } from '@zh/shared';
import type { ExecError, GrypeOutput } from './tool-output-types';
import { buildStandardErrorResult, isToolAvailable } from './adapter-helpers';

// 仅失败的后台 DB 初始化（fire-and-forget，600s、不参与扫描去重）仍直连 execFile；
// 一切"扫描/探测"调用必须走 runToolOnce（A12，见 AGENTS.md「工具调用约定」）。
const execFileAsync = promisify(execFile);

/**
 * grype 漏洞库就绪探测（实机取证 2026-10-28：DB 从未下载成功时，每次扫描都在
 * 下载重试上干等 300s（worker timeout 上限）才降级——用户观感是安全中心卡 5 分钟。
 * `grype db status` 0.2s 纯只读，可作快速探测；未就绪时跳过本次扫描并后台初始化，
 * 「跳过」经 degradationManager 进 report.degraded 横幅显形，绝不伪装 0 检出。）
 */
let dbUpdateInFlight = false;

/** grype DB 未就绪特征（0.121 实测）：「Status:    invalid」/「ERROR database does not exist」 */
const GRYPE_DB_NOT_READY = /invalid|does not exist/i;

async function triggerDbUpdateInBackground(command: string): Promise<void> {
  if (dbUpdateInFlight) return;
  dbUpdateInFlight = true;
  // fire-and-forget：初始化不阻塞扫描返回；完成（无论成败）后重置防重标记，
  // 网络恢复后下次扫描自动重试——否则长驻 worker 进程内只会尝试一次
  void execFileAsync(command, ['db', 'update'], { timeout: 600000 })
    .catch(() => undefined)
    .finally(() => {
      dbUpdateInFlight = false;
    });
}

async function isDbReady(command: string): Promise<boolean> {
  try {
    // A12：经 runToolOnce 派发（一次运行内 db status 只探一次）
    const { stdout } = await runToolOnce(command, ['db', 'status'], { timeout: 15000 });
    return !GRYPE_DB_NOT_READY.test(stdout);
  } catch {
    return false;
  }
}

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
    // 项目本地 → ~/.zhshield/bin → PATH 统一解析（grype 由 install-tools 装入码盾目录）
    return isToolAvailable('grype');
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
    // DB 未就绪 → 不进 300s 下载等待；跳过本次 + 后台初始化（下次扫描 DB 生效）
    if (!(await isDbReady(command))) {
      await triggerDbUpdateInBackground(command);
      throw new Error(
        'grype 漏洞库未就绪（首次使用需联网下载，已后台初始化，稍后重新扫描即生效）',
      );
    }
    // A12：经 runToolOnce 派发（运行作用域内同参只跑一次；作用域外与 execFile 等价）
    const { stdout } = await runToolOnce(command, [source, '-o', 'json'], {
      cwd: path.resolve(options.projectPath),
      timeout: options.timeout || 120000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  }

  private buildErrorResult(start: number, err: ExecError): ToolResult {
    return buildStandardErrorResult('grype', start, err, {
      unavailableHint:
        'Grype 未安装（项目本地 node_modules/.bin、~/.zhshield/bin、PATH 均未找到），可在工具面板引导安装',
      failureMessage: 'Grype 执行失败',
      parsePartial: (stdout) => this.parsePartialOutput(stdout),
    });
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
