/**
 * 回归：depcheck「范围外跳过」被误报成工具不可用（depcheck-adapter-scope.test.ts）
 *
 * 实机取证 2026-10-29：扫描无 package.json 的项目（如纯文档仓库）时，depcheck 输出
 * "Path ... does not contain a package.json file" 且非 JSON，`JSON.parse` 抛错落
 * error 分支 → 被 security 侧 escalate 进 degraded.unavailableTools，与 grype
 * DB 缺失这类真降级混在同一个横幅里，指引用户「恢复工具或联网」——重装无效。
 *
 * 双自证：无清单必 skipped；有清单必不 skipped（防过度裁剪把真检测也裁掉）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DepcheckAdapter } from '../adapters/depcheck-adapter';

function tempProject(withManifest: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depcheck-scope-'));
  if (withManifest) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'probe' }));
  }
  return dir;
}

describe('DepcheckAdapter — 适用范围前置检查', () => {
  it('真阳性：扫描根无 package.json → skipped/out-of-scope，不产生伪降级', async () => {
    const dir = tempProject(false);
    const result = await new DepcheckAdapter().scan({ projectPath: dir, projectId: dir });

    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('out-of-scope');
    expect(result.issues).toEqual([]);
    expect(result.error).toContain('无 package.json');
  });

  it('误报防护：有 package.json 时不得被前置检查短路（真去执行检测）', async () => {
    const dir = tempProject(true);
    const result = await new DepcheckAdapter().scan({ projectPath: dir, projectId: dir });

    // 未被短路：可能 available（检出/干净）或 unavailable（本机未装），
    // 但绝不能是 skipped —— 否则就是过度裁剪把该做的检测也裁掉了。
    expect(result.status).not.toBe('skipped');
    expect(result.skipReason).toBeUndefined();
  });
});
