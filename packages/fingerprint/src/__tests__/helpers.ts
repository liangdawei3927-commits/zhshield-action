// 测试助手：在 os.tmpdir() 下建临时目录 fixture（禁止写真实家目录 / 仓库目录）。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 在临时目录创建文件快照：key = 相对路径（posix），value = 文件内容。返回项目根路径。 */
export function makeTempProject(files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-fp-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

/** 清理临时项目目录（测试收尾，即使断言失败也执行）。 */
export function cleanupTempProject(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
