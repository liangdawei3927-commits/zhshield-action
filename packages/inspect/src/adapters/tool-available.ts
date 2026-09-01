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
 */
export async function isCommandAvailable(resolveCommand: () => Promise<string>): Promise<boolean> {
  try {
    const command = await resolveCommand();
    const { stdout } = await execFileAsync(command, ['--version'], { timeout: 5000 });
    return stdout.length > 0;
  } catch {
    return false;
  }
}
