import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SopCacheManager, SopRegistry } from '@zh/kernel';
import { resolveStatus } from '../components/layout/sidebar-status';

/**
 * 智汇大脑同步状态的「跨包接缝」验证
 *
 * 单测各自验证 kernel 落盘 / UI 判定，但两段之间是否连通没人管——
 * 这正是本项目反复出现的形态 ⑧（组件齐备、接缝断裂）。
 * 本用例用**真实 SopCacheManager**（非 mock）跑完 initialize，
 * 把它产出的快照直接喂给渲染层判定函数，断言最终人看到的那句话。
 *
 * 若 kernel 的 hydrate 被去掉、或 UI 不再读 everSucceeded，这里会红。
 */

const t = (key: string, params?: Record<string, unknown>): string =>
  params ? `${key}:${JSON.stringify(params)}` : key;

describe('跨包接缝：kernel 健康度 → 侧边栏文案', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-brain-seam-'));
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  /** 造一个「老用户」缓存目录：无 sync-state.json，只有 version.json + sync.log */
  function seedLegacyCache(publishedAt: string, logTimestamp: string): void {
    fs.writeFileSync(
      path.join(cacheDir, 'version.json'),
      JSON.stringify({
        version: '1.2026.09.24.209',
        knowledge: '1.2026.09.24',
        experience: '1.2026.09.24',
        malware: '1.2026.09.24',
        hash: 'a'.repeat(64),
        publishedAt,
      }),
    );
    fs.writeFileSync(
      path.join(cacheDir, 'sync.log'),
      JSON.stringify({ timestamp: logTimestamp, from: '1.2026.07.28.001', to: '1.2026.09.24.209' }) +
        '\n',
    );
  }

  async function managerAfterBoot(): Promise<SopCacheManager> {
    const manager = new SopCacheManager(new SopRegistry(), {
      cacheDir,
      remoteBaseUrl: 'http://127.0.0.1:9/api/v1',
    });
    await manager.initialize();
    return manager;
  }

  it('GIVEN 老用户缓存（断网 28 天）WHEN 启动后查询 THEN 说「已 N 天未同步」而非「未接入云端」', async () => {
    const days28 = new Date(Date.now() - 28 * 86_400_000).toISOString();
    seedLegacyCache(days28, days28);

    const manager = await managerAfterBoot();
    const health = manager.getSyncHealthDetail();

    // 接缝 1：kernel 确实从磁盘还原了「曾经成功过」
    expect(health.everSucceeded).toBe(true);
    expect(health.lastSuccessAt).toBe(days28);
    // 接缝 2：渲染层据此给出「过期」而非「未接入」
    expect(resolveStatus(health, t).text).toBe('layout.brainStaleDays:{"days":28}');
    expect(resolveStatus(health, t).text).not.toBe('layout.brainNotConnected');
  });

  it('GIVEN 全新空缓存 WHEN 启动后查询 THEN 才说「未接入云端」', async () => {
    const manager = await managerAfterBoot();
    const health = manager.getSyncHealthDetail();

    expect(health.everSucceeded).toBe(false);
    expect(resolveStatus(health, t).text).toBe('layout.brainNotConnected');
  });

  it('GIVEN 刚同步成功（today）WHEN 启动后查询 THEN 说「云协同运行正常」', async () => {
    const now = new Date().toISOString();
    seedLegacyCache(now, now);

    const manager = await managerAfterBoot();
    const health = manager.getSyncHealthDetail();

    expect(health.level).toBe(0);
    expect(resolveStatus(health, t).text).toBe('layout.brainHealthy');
  });

  it('GIVEN 同步了一个昨天发布的包 WHEN 今天刚同步成功 THEN 不得显示待更新', async () => {
    // 这是 publishedAt 与真实同步时刻分离的场景：
    // 若只用 publishedAt 回溯，今天刚成功的同步会被算成 1 天前 → 误显「规则待更新」。
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const now = new Date().toISOString();
    seedLegacyCache(yesterday, now);

    const manager = await managerAfterBoot();
    const health = manager.getSyncHealthDetail();

    expect(health.lastSuccessAt).toBe(now);
    expect(health.level).toBe(0);
    expect(resolveStatus(health, t).text).toBe('layout.brainHealthy');
  });
});
