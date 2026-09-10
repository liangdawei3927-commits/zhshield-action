import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * isCommandAvailable — 探测某个工具命令是否可用。
 *
 * 原实现被 8 个 tool adapter（typescript / ts-prune / dependency-cruiser /
 * depcheck / jscpd / gitleaks / eslint / semgrep）逐字复制，现收敛为唯一实现。
 *
 * 语义保持严格等价：解析出命令后执行 `--version`，stdout 非空即认为可用；
 * 命令解析或执行任何一步失败均视为不可用。
 *
 * 超时取 20s：缺失工具以 ENOENT 瞬时失败（不受超时影响），而 semgrep 等
 * Python 工具冷启动 --version 实测可达 7.6s，5s 超时会误判「未安装」。
 */
export async function isCommandAvailable(
  resolveCommand: () => Promise<string>,
  timeoutMs = 20000,
): Promise<boolean> {
  try {
    const command = await resolveCommand();
    const { stdout } = await execFileAsync(command, ['--version'], { timeout: timeoutMs });
    return stdout.length > 0;
  } catch {
    return false;
  }
}
