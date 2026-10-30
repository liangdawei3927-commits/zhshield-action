import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { semgrepMapper } from '@zh/shared';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import type {
  ToolAdapter,
  ToolMeta,
  ToolResult,
  ToolScanOptions,
  Issue,
  CodeFlow,
  CodeFlowThreadFlow,
} from '@zh/shared';
import { resolveToolCommandDetailed } from '@zh/shared';
import type { ExecError, SemgrepOutput, SemgrepResult } from './tool-output-types';

const execFileAsync = promisify(execFile);

const META: ToolMeta = {
  id: 'semgrep',
  name: 'Semgrep',
  category: 'security',
  priority: 'P0',
  installMode: 'builtin',
  description: '自定义安全 SOP 规则扫描',
  cliCommand: 'semgrep',
  homepage: 'https://semgrep.dev',
  license: 'LGPL-2.1',
};

export class SemgrepAdapter implements ToolAdapter {
  meta = META;

  async isAvailable(): Promise<boolean> {
    // 与 InspectEngine 用同一套解析（项目本地 → ~/.zhshield/bin → PATH）：
    // 此前裸命令只认 PATH，导致「工具就绪面板说已装、安全中心却报未安装」。
    const { origin } = await resolveToolCommandDetailed('semgrep');
    return origin !== 'unresolved';
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const rulesDir = this.resolveRulesDir(options.projectPath);

    try {
      return await this.executeScan(options, rulesDir, start);
    } catch (error) {
      return this.buildErrorResult(start, error as ExecError);
    }
  }

  private async executeScan(
    options: ToolScanOptions,
    rulesDir: string | null,
    start: number,
  ): Promise<ToolResult> {
    if (!rulesDir || !(await this.rulesDirAccessible(rulesDir))) {
      return this.buildSkippedResult(start);
    }
    const args = this.buildScanArgs(rulesDir, options);
    const output = await this.runSemgrep(args, options);
    const issues = this.mapOutput(output);
    return this.buildAvailableResult(start, output, issues);
  }

  private async rulesDirAccessible(rulesDir: string): Promise<boolean> {
    try {
      await fs.promises.access(rulesDir);
      return true;
    } catch {
      return false;
    }
  }

  private buildSkippedResult(start: number): ToolResult {
    return {
      tool: 'semgrep',
      status: 'skipped',
      issues: [],
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: 0,
      },
      error: 'Semgrep 规则目录不存在，请先同步云脑规则',
    };
  }

  private buildAvailableResult(start: number, output: SemgrepOutput, issues: Issue[]): ToolResult {
    return {
      tool: 'semgrep',
      status: 'available',
      issues,
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: output?.results?.length || 0,
      },
    };
  }

  private buildScanArgs(rulesDir: string, options: ToolScanOptions): string[] {
    // 快速模式只关心 ERROR 级：若规则目录提供 high-severity 子集则用它，否则回退整目录
    // 并用 semgrep 的 --severity 过滤。此前无条件拼 rulesDir/high-severity，而内置规则
    // 资产（@zh/kernel/dist/assets/semgrep）从来没有该子目录 → 必然 "unable to find
    // config" 报 error，快速扫描永远拿不到结果。
    const errorOnly = options.config?.severity?.includes('ERROR') === true;
    const highSeverityDir = path.join(rulesDir, 'high-severity');
    const useHighSeverityDir = errorOnly && fs.existsSync(highSeverityDir);
    const args = ['scan', '--config', useHighSeverityDir ? highSeverityDir : rulesDir, '--json'];
    if (errorOnly && !useHighSeverityDir) {
      args.push('--severity', 'ERROR');
    }
    if (options.targetFiles && options.targetFiles.length > 0) {
      args.push(...options.targetFiles);
    } else {
      // 归一化 projectPath 为绝对路径：相对路径会作为扫描目标传给 semgrep，
      // semgrep 以自身 cwd 解析导致 "unable to find a config; path ... does not exist"。
      args.push(path.resolve(options.projectPath));
    }
    return args;
  }

  private async runSemgrep(args: string[], options: ToolScanOptions): Promise<SemgrepOutput> {
    // 统一解析：项目本地 → ~/.zhshield/bin → PATH（裸命令只认 PATH）
    const { command } = await resolveToolCommandDetailed('semgrep', options.projectPath);
    const { stdout } = await execFileAsync(command, args, {
      cwd: path.resolve(options.projectPath),
      timeout: options.timeout || 300000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  }

  private buildErrorResult(start: number, err: ExecError): ToolResult {
    if (err.code === 'ENOENT') {
      return {
        tool: 'semgrep',
        status: 'unavailable',
        issues: [],
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: 0,
        },
        error: 'Semgrep 未安装（项目本地 node_modules/.bin、~/.zhshield/bin、PATH 均未找到）',
      };
    }
    const partialIssues = this.parsePartialOutput(err.stdout);
    if (partialIssues) {
      return {
        tool: 'semgrep',
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
      tool: 'semgrep',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error: err.stderr || err.message || 'Semgrep 执行失败',
    };
  }

  private parsePartialOutput(stdout: string | undefined): Issue[] | null {
    if (!stdout) return null;
    try {
      const output = JSON.parse(stdout);
      if (Array.isArray(output?.results)) {
        return this.mapOutput(output);
      }
    } catch {
      // 部分输出可能不是合法 JSON
    }
    return null;
  }

  private resolveRulesDir(projectPath: string): string | null {
    // 归一化 projectPath 为绝对路径：相对路径会流入 --config 参数，
    // semgrep 以自身 cwd 解析导致 "unable to find a config; path ... does not exist"。
    projectPath = path.resolve(projectPath);
    const candidates = [
      path.join(projectPath, '.zhshield', 'semgrep-rules'),
      path.join(projectPath, '.semgrep', 'rules'),
    ];
    for (const dir of candidates) {
      if (fs.existsSync(dir)) return dir;
    }
    return this.resolveKernelRulesDir();
  }

  /** 项目未同步云脑规则时回退到 @zh/kernel 内置规则资产（dist/assets/semgrep） */
  private resolveKernelRulesDir(): string | null {
    for (const base of [process.cwd(), __dirname]) {
      try {
        const require = createRequire(path.join(base, 'package.json'));
        const pkgJson = require.resolve('@zh/kernel/package.json', { paths: [base] });
        const kernelRoot = path.dirname(pkgJson);
        const dir = path.join(kernelRoot, 'dist', 'assets', 'semgrep');
        if (fs.existsSync(dir)) return dir;
      } catch {
        // 该 base 下不可解析，继续
      }
    }
    return null;
  }

  private mapOutput(output: SemgrepOutput): Issue[] {
    // 公共字段由 @zh/shared 的 semgrepMapper 产出：它与 data.results 一一对应，
    // 故按下标把本适配器独有的污点链（codeFlows）回填到对应 Issue 上。
    const results = output.results ?? [];
    return semgrepMapper(output).map((issue, idx) => ({
      ...issue,
      codeFlows: this.mapDataflowTrace(results[idx]),
    }));
  }

  /** dataflow_trace → SARIF 兼容 codeFlows（source→sink 污点链；缺 location 子对象的条目跳过）。顶层与 extra 嵌套两种落点都接受 */
  private mapDataflowTrace(result: SemgrepResult): CodeFlow[] | undefined {
    const trace = result.dataflow_trace ?? result.extra?.dataflow_trace;
    const codeFlows = trace?.code_flows;
    if (!codeFlows || codeFlows.length === 0) return undefined;
    const flows: CodeFlow[] = [];
    for (const codeFlow of codeFlows) {
      const threadFlows: CodeFlowThreadFlow[] = [];
      for (const threadFlow of codeFlow.thread_flows ?? []) {
        const locations = (threadFlow.locations ?? [])
          .filter((loc) => loc.location)
          .map((loc) => ({
            location: {
              file: loc.location?.path ?? '',
              line: loc.location?.start?.line ?? 0,
              column: loc.location?.start?.col ?? 0,
            },
            message: loc.message,
          }));
        threadFlows.push({ locations });
      }
      if (threadFlows.length > 0) flows.push({ threadFlows });
    }
    return flows.length > 0 ? flows : undefined;
  }
}
