import * as os from 'node:os';
import * as path from 'node:path';

// 反向样本（曾被误报）：来源是 os.homedir() / __dirname，均非外部输入。
// 期望：本文件不得被 path-traversal 报出。
export function configPath(): string {
  return path.join(os.homedir(), '.zhshield', 'config.json');
}

export function moduleRelative(): string {
  return path.resolve(__dirname, '..', 'assets');
}
