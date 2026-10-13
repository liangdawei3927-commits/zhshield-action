import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'child_process';

const IS_WINDOWS = process.platform === 'win32';
const TREE_KILL_GRACE_MS = 3000;

/**
 * 以独立进程组启动子进程（POSIX）。dev 类命令（npm → turbo → vite/electron）会派生多层子孙，
 * 只有让子进程成为进程组组长，才能用 process.kill(-pid) 一次性回收整棵树，避免退出/重启后
 * 留下孤儿继续占用端口；Windows 无进程组语义，保持默认（回收时改用 taskkill /T）。
 */
export function spawnInGroup(command: string, args: string[], options: SpawnOptions): ChildProcess {
  return spawn(command, args, { ...options, detached: !IS_WINDOWS });
}

/**
 * 回收子进程及其整棵子树：POSIX 先向进程组发 SIGTERM，宽限期后仍存活则 SIGKILL；
 * 无 pid 或非 POSIX 时退化为对直接子进程 kill。任何路径都不抛出。
 */
export function terminateProcessTree(proc: ChildProcess | null, graceMs = TREE_KILL_GRACE_MS): void {
  if (!proc) return;
  const pid = proc.pid;

  if (IS_WINDOWS) {
    if (typeof pid === 'number') {
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // 进程可能已退出；best-effort 回收
      }
    } else {
      killDirect(proc);
    }
    return;
  }

  if (typeof pid !== 'number') {
    killDirect(proc);
    return;
  }
  if (!signalGroup(pid, 'SIGTERM')) {
    killDirect(proc);
    return;
  }
  const timer = setTimeout(() => {
    if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
  }, graceMs);
  timer.unref?.();
}

function killDirect(proc: ChildProcess): void {
  try {
    proc.kill('SIGTERM');
  } catch {
    // 已退出
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
