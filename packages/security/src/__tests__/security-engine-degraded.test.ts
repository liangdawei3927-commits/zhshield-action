/**
 * P1-4 回归：安全扫描降级显形（security-engine-degraded.test.ts）
 *
 * 缺陷（实测报告 2026-10-27）：安全中心一键扫描恒「0 高危」——5 个外部工具
 * 未安装、依赖审计需联网，全部失败后被静默吞掉，vulnTotal=0 被前端读成
 * 「没有漏洞」，页面成了空壳，security 分还由密钥域代算掩盖空转。
 *
 * 修复：报告随行 degraded 元数据（不可用工具清单 + 审计失败原因）。
 * 「0 检出 + degraded」= 没检测成；「0 检出 + 无 degraded」= 查过且干净。
 * 误报防护：全部工具可用且审计成功时，绝不带 degraded 字段。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SecurityEngine } from '../engine';

function makeAdapter(id: string, scanImpl: () => Promise<unknown>) {
  return {
    meta: { id, name: id, version: '1.0.0', category: 'security' as const },
    isAvailable: async () => true as const,
    scan: scanImpl,
  };
}

/** 空 dir 无 lockfile：审计链不会跑任何命令，lastError 为空 */
function emptyProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-degraded-'));
  return dir;
}

describe('SecurityEngine 降级显形（P1-4）', () => {
  it('真阳性：工具执行抛错 → report.degraded.unavailableTools 含该工具', async () => {
    const engine = new SecurityEngine();
    engine.registerAdapter(
      makeAdapter('broken-tool', async () => {
        throw new Error('trivy binary not found');
      }),
    );
    const report = await engine.runSecurityScan('proj', emptyProject());
    expect(report.degraded).toBeDefined();
    expect(report.degraded?.unavailableTools).toContain('broken-tool');
  });

  it('真阳性：适配器自报 unavailable → 也计入降级清单', async () => {
    const engine = new SecurityEngine();
    engine.registerAdapter(
      makeAdapter('absent-tool', async () => ({
        status: 'unavailable',
        issues: [],
        metadata: { fileCount: 0 },
      })),
    );
    const report = await engine.runSecurityScan('proj', emptyProject());
    expect(report.degraded?.unavailableTools).toContain('absent-tool');
  });

  it('误报防护：无适配器 + 无审计失败 → 不带 degraded（0 检出 = 真干净）', async () => {
    const engine = new SecurityEngine();
    const report = await engine.runSecurityScan('proj', emptyProject());
    expect(report.degraded).toBeUndefined();
    expect(report.summary.vulnTotal).toBe(0);
  });

  it('误报防护：工具正常完成（available）→ 不带 degraded', async () => {
    const engine = new SecurityEngine();
    engine.registerAdapter(
      makeAdapter('healthy-tool', async () => ({
        status: 'available',
        issues: [],
        metadata: { fileCount: 3 },
      })),
    );
    const report = await engine.runSecurityScan('proj', emptyProject());
    expect(report.degraded).toBeUndefined();
  });
});
