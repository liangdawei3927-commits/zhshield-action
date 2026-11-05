/**
 * A12 第一个切片：`--version` 探测的进程内 single-flight
 *
 * 背景（2026-11-03 进程级实测，`pnpm verify:tool-dedup`）：
 *   一次 `pipeline --full` 里同一把刀被反复探测 —— gitleaks ×4、semgrep ×3、
 *   jscpd ×3、depcheck ×2。探测结果在一次运行内不会变，重复 spawn 是纯浪费，
 *   而且这些不必要的进程恰恰是 A14 时长噪声的来源之一。
 *
 * 本文件锁住四件事，改动 probe 实现前先读：
 *   ① 同命令 TTL 内只 spawn 一次（含并发同时到达，不能起两个）
 *   ② 失败同样缓存（ENOENT 也是一次真实 spawn）
 *   ③ TTL 过期 / 显式失效后必须能重新探测（否则桌面端装完工具永远显示"未安装"）
 *   ④ 语义不变：`ok` 只表示进程成功退出，stdout 空不能算可用（由调用方判定）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const spawns: Array<{ command: string; args: unknown[]; timeoutMs: number }> = [];
let behavior: 'ok' | 'enoent' | 'empty' | 'slow-ok' | 'timeout' | 'nonzero' = 'ok';

vi.mock('node:child_process', () => ({
  execFile: (
    command: string,
    args: unknown[],
    options: { timeout?: number },
    callback: (err: unknown, result?: { stdout: string; stderr: string }) => void,
  ) => {
    spawns.push({ command, args, timeoutMs: options?.timeout ?? 0 });
    const respond = (): void => {
      if (behavior === 'enoent') {
        callback(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
        return;
      }
      if (behavior === 'timeout') {
        // Node 超时杀掉子进程时的形状：killed + signal，code 为 null
        callback(
          Object.assign(new Error('Command failed: ETIMEDOUT'), {
            killed: true,
            signal: 'SIGTERM',
          }),
        );
        return;
      }
      if (behavior === 'nonzero') {
        callback(Object.assign(new Error('Command failed'), { code: 1 }));
        return;
      }
      const stdout = behavior === 'empty' ? '' : `tool 1.2.3\n`;
      callback(null, { stdout, stderr: '' });
    };
    if (behavior === 'slow-ok') setTimeout(respond, 20);
    else respond();
  },
}));

const { probeToolVersion, invalidateToolProbes, setToolProbeTtlMs, __resetToolProbeCache } =
  await import('../tool-probe');

describe('probeToolVersion — 同一命令只 spawn 一次', () => {
  beforeEach(() => {
    __resetToolProbeCache();
    spawns.length = 0;
    behavior = 'ok';
  });

  it('两次顺序调用只起一次进程，结果共享', async () => {
    const first = await probeToolVersion('/usr/local/bin/semgrep', 20_000);
    const second = await probeToolVersion('/usr/local/bin/semgrep', 20_000);

    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({ command: '/usr/local/bin/semgrep', args: ['--version'] });
    expect(second).toBe(first);
  });

  it('并发同时到达也只起一次（single-flight 而非"先查缓存再各自跑"）', async () => {
    behavior = 'slow-ok';
    const [a, b, c] = await Promise.all([
      probeToolVersion('gitleaks'),
      probeToolVersion('gitleaks'),
      probeToolVersion('gitleaks'),
    ]);
    expect(spawns).toHaveLength(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('不同命令各自探测（不能被同名折叠）', async () => {
    await probeToolVersion('semgrep');
    await probeToolVersion('/opt/tools/semgrep');
    expect(spawns).toHaveLength(2);
  });

  it('失败结果同样缓存：ENOENT 不会因为重试被反复 spawn', async () => {
    behavior = 'enoent';
    const first = await probeToolVersion('missing-tool');
    const second = await probeToolVersion('missing-tool');

    expect(spawns).toHaveLength(1);
    expect(first.ok).toBe(false);
    expect(second).toBe(first);
  });

  it('stdout 为空时 ok 仍为 true —— 是否"可用"由调用方按自己口径判定', async () => {
    behavior = 'empty';
    const probe = await probeToolVersion('weird-tool');
    expect(probe.ok).toBe(true);
    expect(probe.stdout).toBe('');
  });

  it('非零退出是结论明确：进程确实存在，故缓存不重探', async () => {
    behavior = 'nonzero';
    const first = await probeToolVersion('pick-y-tool');
    const second = await probeToolVersion('pick-y-tool');
    expect(spawns).toHaveLength(1);
    expect(first.ok).toBe(false);
    expect(first.conclusive).toBe(true);
    expect(second).toBe(first);
  });

  it('超时/被信号杀掉不缓存：一次机器抖动不得变成整轮"工具不可用"', async () => {
    behavior = 'timeout';
    const first = await probeToolVersion('semgrep', 20_000);
    expect(first.ok).toBe(false);
    expect(first.conclusive).toBe(false);

    // 抖动过去后重试必须真的重探，而不是复用"没测出来"的结论
    behavior = 'ok';
    const second = await probeToolVersion('semgrep', 20_000);
    expect(spawns).toHaveLength(2);
    expect(second.ok).toBe(true);
  });
});

describe('probeToolVersion — 失效与 TTL（桌面端装完工具必须能被看到）', () => {
  beforeEach(() => {
    __resetToolProbeCache();
    spawns.length = 0;
    behavior = 'ok';
  });

  it('invalidateToolProbes(命令) 之后重新探测', async () => {
    await probeToolVersion('trivy');
    invalidateToolProbes('trivy');
    await probeToolVersion('trivy');
    expect(spawns).toHaveLength(2);
  });

  it('invalidateToolProbes() 无参清空全部', async () => {
    await probeToolVersion('a');
    await probeToolVersion('b');
    invalidateToolProbes();
    await probeToolVersion('a');
    expect(spawns).toHaveLength(3);
  });

  it('TTL 过期后重新探测（0 = 关闭缓存）', async () => {
    setToolProbeTtlMs(0);
    await probeToolVersion('depcheck');
    await probeToolVersion('depcheck');
    expect(spawns).toHaveLength(2);
  });

  it('TTL 内的调用命中缓存，不重复 spawn', async () => {
    setToolProbeTtlMs(60_000);
    await probeToolVersion('jscpd');
    await probeToolVersion('jscpd');
    expect(spawns).toHaveLength(1);
  });

  it('缓存是**进程级**的：同一进程里另加载一份本模块也共享（注入副本/内联多拷贝）', async () => {
    // 现状：@zh/* 按消费者注入副本，CLI bundle 又内联一份 —— 同一进程可能加载多份本模块。
    // 若缓存只是模块级 Map，每份副本各探一次，进程内合并等于没做（实测 3 份副本 → 3 次探测）。
    await probeToolVersion('semgrep');

    vi.resetModules(); // 模拟"另一份副本"
    const second = await import('../tool-probe');
    expect(second.probeToolVersion).not.toBe(probeToolVersion); // 确实是两份模块

    const again = await second.probeToolVersion('semgrep');

    expect(spawns).toHaveLength(1); // 但只有一次真实 spawn
    expect(again.ok).toBe(true);
  });

  it('裸名与绝对路径指向同一可执行文件 → 共享一次探测（jscpd ×2 的真因）', async () => {
    // 实测：tool-resolve/tool-manager 传裸名 `jscpd`，inspect/tool-available 传解析后的
    // 绝对路径；按调用字符串做 key 就是两份缓存，同一工具仍探两次。
    // 造一个真实可执行文件放进临时 PATH，再从两个形态各探一次。
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-identity-'));
    const bin = path.join(binDir, 'identity-tool');
    fs.writeFileSync(bin, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
    try {
      await probeToolVersion('identity-tool');
      await probeToolVersion(bin);
    } finally {
      process.env.PATH = originalPath;
    }

    expect(spawns).toHaveLength(1);
  }, 20_000);

  it('不同安装（不同 realpath）不合并 —— 版本号不许张冠李戴', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-b-'));
    const binA = path.join(dirA, 'dup-tool');
    const binB = path.join(dirB, 'dup-tool');
    fs.writeFileSync(binA, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
    fs.writeFileSync(binB, '#!/bin/sh\necho 2.0.0\n', { mode: 0o755 });

    await probeToolVersion(binA);
    await probeToolVersion(binB);

    expect(spawns).toHaveLength(2);
  }, 20_000);

  it('长驻进程不无限增长：条目触顶时回收（先扫过期，再丢最旧一半）', async () => {
    setToolProbeTtlMs(60_000);
    // 用不同命令名制造不同 key（不存在的命令 → ENOENT，结论明确、照常缓存）
    for (let i = 0; i < 300; i += 1) {
      await probeToolVersion(`missing-tool-${i}`);
    }
    // 触发过回收：总数必须显著小于 300（且后续探测仍正常）
    const beforeRecovery = spawns.length;
    await probeToolVersion('missing-tool-299');
    expect(spawns.length).toBe(beforeRecovery); // 299 仍在缓存里 → 未重新 spawn
    await probeToolVersion('missing-tool-0');
    expect(spawns.length).toBeGreaterThan(beforeRecovery); // 最旧的已被回收 → 重新探测
  }, 30_000);
});
