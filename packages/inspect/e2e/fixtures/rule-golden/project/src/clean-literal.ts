import * as path from 'node:path';

// 反向样本（曾被误报）：参数全为字面量，不存在污点流。
// 期望：本文件不得被 path-traversal 报出。
export function reportsDir(): string {
  return path.join('.zhshield', 'reports');
}

export function assetPath(): string {
  return path.resolve('assets', 'rules');
}
