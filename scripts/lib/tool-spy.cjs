/**
 * A12 工具进程观测器（`node --require` 预加载）
 *
 * 为什么能做到"零侵入且精确"：所有外部工具最终都由 **本进程** 的
 * `child_process` 派发（各引擎用 execFile / execFileSync / spawn，没有一个自建 worker
 * 或独立守护进程）。因此在本进程启动前把 `child_process` 的导出替换为记录版，
 * 就能拿到每次工具调用**精确的**命令与参数 —— 比 `ps` 轮询采样可靠（不会漏掉短命
 * 进程），也比在引擎里插桩安全（不改产品代码，不制造第二份实现）。
 *
/**
 * 记录格式：JSONL，每行 `{ pid, kind, cmd, args }`，写到 `ZH_TOOL_SPY_LOG`。
 * 派发点全量覆盖（exec/execSync/execFile/execFileSync/spawn/spawnSync）：漏掉任一种
 * 都会让 A12 的计数偏向"看起来没跑"，而假阴性正是这条验收最怕的错。
 *
 * ⚠️ 保真性：`exec` / `execFile` 身上带着 `util.promisify.custom`。产品代码普遍写成
 * `promisify(execFile)`，一旦包装版丢掉这个符号，promisify 会退回"回调单值"形态 ——
 * 解析出来的 `stdout` 变成 undefined，**所有工具都会被判成不可用**。2026-11-03 实测：
 * 这个缺陷让 `inspect --sop` 报出 18 项"工具不可用"、semgrep 一次都没派发，差一步把
 * "SOP 链路不扫 semgrep"当成产品结论。观测器失真比不观测更危险。
 */
const fs = require('node:fs');
const cp = require('node:child_process');
const { promisify } = require('node:util');

const LOG = process.env.ZH_TOOL_SPY_LOG;

function record(kind, cmd, args) {
  if (!LOG) return;
  try {
    fs.appendFileSync(
      LOG,
      `${JSON.stringify({
        pid: process.pid,
        kind,
        cmd: String(cmd),
        args: Array.isArray(args) ? args.map(String) : [],
      })}\n`,
    );
  } catch {
    // 观测失败绝不影响被测进程本身
  }
}

/** 参数位可能是数组、也可能是 options/callback（exec 家族的重载） */
function argsOf(candidate) {
  return Array.isArray(candidate) ? candidate : [];
}

/**
 * 给包装函数装回与 Node 原生 `exec`/`execFile` 等价的 promisify 形态：
 * 成功解析 `{ stdout, stderr }`，失败把 stdout/stderr 挂到 error 上再 reject。
 * 这就是 Node 内置 `util.promisify.custom` 的行为，包装层必须原样复刻。
 */
function attachPromisifyCustom(wrapped, callbackStyle) {
  try {
    Object.defineProperty(wrapped, promisify.custom, {
      value: (file, args, options) =>
        new Promise((resolve, reject) => {
          callbackStyle(file, args, options, (error, stdout, stderr) => {
            if (error) {
              error.stdout = stdout;
              error.stderr = stderr;
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          });
        }),
      enumerable: false,
      configurable: true,
    });
  } catch {
    // 观测失败绝不影响被测进程本身
  }
}

if (LOG) {
  const original = {
    exec: cp.exec,
    execSync: cp.execSync,
    execFile: cp.execFile,
    execFileSync: cp.execFileSync,
    spawn: cp.spawn,
    spawnSync: cp.spawnSync,
  };

  cp.exec = function exec(command, ...rest) {
    record('exec', command, []);
    return original.exec.call(this, command, ...rest);
  };
  cp.execSync = function execSync(command, ...rest) {
    record('execSync', command, []);
    return original.execSync.call(this, command, ...rest);
  };
  cp.execFile = function execFile(file, ...rest) {
    record('execFile', file, argsOf(rest[0]));
    return original.execFile.call(this, file, ...rest);
  };
  cp.execFileSync = function execFileSync(file, ...rest) {
    record('execFileSync', file, argsOf(rest[0]));
    return original.execFileSync.call(this, file, ...rest);
  };
  cp.spawn = function spawn(command, ...rest) {
    record('spawn', command, argsOf(rest[0]));
    return original.spawn.call(this, command, ...rest);
  };
  cp.spawnSync = function spawnSync(command, ...rest) {
    record('spawnSync', command, argsOf(rest[0]));
    return original.spawnSync.call(this, command, ...rest);
  };

  // promisify 形态保真（漏了这一步，产品侧 promisify(execFile) 会拿到空 stdout）
  attachPromisifyCustom(cp.exec, (command, options, callback) =>
    cp.exec(command, options, callback),
  );
  attachPromisifyCustom(cp.execFile, (file, args, options, callback) =>
    cp.execFile(file, args, options, callback),
  );
}
