import { probeToolVersion } from '@zh/shared';

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
 *
 * 探测本身经 `@zh/shared` 的 single-flight 合并（A12）：同一次运行里
 * inspect / security / guard 三处探同一命令只起一次进程 —— 实测原本
 * gitleaks ×4、semgrep ×3、jscpd ×3、depcheck ×2。
 */
export async function isCommandAvailable(
  resolveCommand: () => Promise<string>,
  timeoutMs = 20000,
): Promise<boolean> {
  try {
    const command = await resolveCommand();
    const probe = await probeToolVersion(command, timeoutMs);
    return probe.ok && probe.stdout.length > 0;
  } catch {
    return false;
  }
}
