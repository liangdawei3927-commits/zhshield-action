import { execFileSync } from 'node:child_process';

/** 从 unknown 类型的 catch 错误中安全提取 message */
export function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** git 执行失败（非零退出 / 无 git）一律返回 undefined，由调用方给原因 */
export function tryGit(repoRoot: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}
