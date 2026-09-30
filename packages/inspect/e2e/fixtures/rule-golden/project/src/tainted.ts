import * as path from 'node:path';

// 真阳性样本：外部输入（process.argv）经未净化的拼接流向 path.resolve。
// 期望：security.scan.semgrep.path-traversal 报出本文件。
export function resolveFromArgv(): string {
  const invoked = process.argv[2] ?? '.';
  return path.resolve(invoked);
}
