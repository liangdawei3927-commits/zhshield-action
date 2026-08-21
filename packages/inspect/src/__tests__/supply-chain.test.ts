import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { TOOL_LICENSE_REGISTRY } from '@zh/shared';
import { SupplyChainManager, LockfileLicenseAuditor, ToolUnavailableError } from '../toolchain/supply-chain';
import type { ToolDownloader } from '../toolchain/supply-chain';
import type { ToolInstallRecord } from '@zh/shared';

function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('SupplyChainManager', () => {
  let tmpDir: string;
  let lockfilePath: string;
  let binDir: string;
  let downloader: ToolDownloader;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-supply-'));
    lockfilePath = path.join(tmpDir, 'tool-lockfile.json');
    binDir = path.join(tmpDir, 'bin');
    downloader = {
      async download(url: string): Promise<Buffer> {
        return Buffer.from(`binary-for-${url}`, 'utf-8');
      },
    };
  });

  function makeManager(): SupplyChainManager {
    return new SupplyChainManager({ lockfilePath, binDir, downloader });
  }

  const requirement = {
    toolId: 'gitleaks',
    version: '8.18.0',
    expectedSha256: sha256Of(Buffer.from('binary-for-https://github.com/gitleaks/gitleaks/releases/download/v8.18.0/gitleaks', 'utf-8')),
    officialSource: 'https://github.com/gitleaks/gitleaks/releases/download/v8.18.0/gitleaks',
    mirrorSources: ['https://mirror.example.com/gitleaks/8.18.0'],
  };

  it('官方渠道下载成功应记录 ToolInstallRecord 并写入 lockfile', async () => {
    const manager = makeManager();
    const record = await manager.ensureTool(requirement);

    expect(record.toolId).toBe('gitleaks');
    expect(record.version).toBe('8.18.0');
    expect(record.channel).toBe('official');
    expect(record.sha256).toBe(requirement.expectedSha256);
    expect(record.sourceUrl).toBe(requirement.officialSource);

    const saved = await fs.readFile(lockfilePath, 'utf-8');
    const lockfile = JSON.parse(saved);
    expect(lockfile.tools.gitleaks.sha256).toBe(requirement.expectedSha256);
    expect(await manager.binaryPath('gitleaks')).toBe(path.join(binDir, 'gitleaks'));
  });

  it('已装且哈希匹配应直接复用（不重新下载）', async () => {
    const manager = makeManager();
    const first = await manager.ensureTool(requirement);

    let downloadCalls = 0;
    const countingDownloader: ToolDownloader = {
      async download(url: string): Promise<Buffer> {
        downloadCalls += 1;
        return Buffer.from(`binary-for-${url}`, 'utf-8');
      },
    };
    const manager2 = new SupplyChainManager({ lockfilePath, binDir, downloader: countingDownloader });
    const second = await manager2.ensureTool(requirement);

    expect(second.sha256).toBe(first.sha256);
    expect(downloadCalls).toBe(0);
  });

  it('官方渠道失败应镜像回退且记录 channel=mirror', async () => {
    const officialBytes = Buffer.from('binary-for-https://github.com/gitleaks/gitleaks/releases/download/v8.18.0/gitleaks', 'utf-8');
    const failingOfficial: ToolDownloader = {
      async download(url: string): Promise<Buffer> {
        if (url.includes('mirror.example.com')) {
          return officialBytes;
        }
        throw new Error('official unreachable');
      },
    };
    const manager = new SupplyChainManager({ lockfilePath, binDir, downloader: failingOfficial });
    const record = await manager.ensureTool(requirement);

    expect(record.channel).toBe('mirror');
    expect(record.sourceUrl).toBe('https://mirror.example.com/gitleaks/8.18.0');
  });

  it('全部渠道失败应抛 ToolUnavailableError 且不写 lockfile', async () => {
    const alwaysFail: ToolDownloader = {
      async download(): Promise<Buffer> {
        throw new Error('network down');
      },
    };
    const manager = new SupplyChainManager({ lockfilePath, binDir, downloader: alwaysFail });

    await expect(manager.ensureTool(requirement)).rejects.toBeInstanceOf(ToolUnavailableError);
    await expect(fs.readFile(lockfilePath, 'utf-8')).rejects.toThrow();
  });

  it('下载哈希与官方发布不一致应拒绝安装', async () => {
    const tampered: ToolDownloader = {
      async download(): Promise<Buffer> {
        return Buffer.from('tampered-binary', 'utf-8');
      },
    };
    const manager = new SupplyChainManager({ lockfilePath, binDir, downloader: tampered });

    await expect(manager.ensureTool(requirement)).rejects.toThrow('sha256 校验失败');
    await expect(fs.readFile(lockfilePath, 'utf-8')).rejects.toThrow();
  });

  it('verifyBeforeRun：未安装返回 false', async () => {
    const manager = makeManager();
    expect(await manager.verifyBeforeRun('gitleaks')).toBe(false);
  });

  it('verifyBeforeRun：二进制被替换（哈希不匹配）返回 false', async () => {
    const manager = makeManager();
    await manager.ensureTool(requirement);
    await fs.writeFile(path.join(binDir, 'gitleaks'), Buffer.from('evil-binary', 'utf-8'), { mode: 0o755 });

    expect(await manager.verifyBeforeRun('gitleaks')).toBe(false);
  });

  it('verifyBeforeRun：哈希匹配返回 true', async () => {
    const manager = makeManager();
    await manager.ensureTool(requirement);
    expect(await manager.verifyBeforeRun('gitleaks')).toBe(true);
  });

  it('importOfflineBundle 应导入本地包并记录 channel=mirror', async () => {
    const bundlePath = path.join(tmpDir, 'gitleaks-offline.tar.gz');
    await fs.writeFile(bundlePath, Buffer.from('offline-bundle-bytes', 'utf-8'));

    const manager = makeManager();
    const record: ToolInstallRecord = await manager.importOfflineBundle('gitleaks', bundlePath);

    expect(record.channel).toBe('mirror');
    expect(record.sha256).toBe(sha256Of(Buffer.from('offline-bundle-bytes', 'utf-8')));
    expect(record.sourceUrl).toContain('gitleaks-offline.tar.gz');
    expect(await manager.verifyBeforeRun('gitleaks')).toBe(true);
  });
});

describe('LockfileLicenseAuditor', () => {
  let tmpDir: string;
  let lockfilePath: string;
  let binDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-license-'));
    lockfilePath = path.join(tmpDir, 'tool-lockfile.json');
    binDir = path.join(tmpDir, 'bin');
  });

  it('风险未知工具应列为 blocker', async () => {
    const downloader: ToolDownloader = {
      async download(url: string): Promise<Buffer> {
        return Buffer.from(`data-${url}`, 'utf-8');
      },
    };
    const manager = new SupplyChainManager({ lockfilePath, binDir, downloader });
    await manager.ensureTool({
      toolId: 'unknown-tool',
      version: '1.0.0',
      officialSource: 'https://example.com/unknown-tool',
    });

    const report = await new LockfileLicenseAuditor(lockfilePath).audit();
    expect(report.blockers).toContain('unknown-tool@1.0.0');
    expect(report.tools[0].spdxId).toBe('UNKNOWN');
    expect(report.tools[0].risk).toBe('block');
  });

  it('Trivy 应列为 review（AGPL-3.0）', async () => {
    const downloader: ToolDownloader = {
      async download(url: string): Promise<Buffer> {
        return Buffer.from(`data-${url}`, 'utf-8');
      },
    };
    const manager = new SupplyChainManager({ lockfilePath, binDir, downloader });
    await manager.ensureTool({
      toolId: 'trivy',
      version: '0.52.0',
      officialSource: 'https://example.com/trivy',
    });

    const report = await new LockfileLicenseAuditor(lockfilePath).audit();
    const trivy = report.tools.find((t) => t.toolId === 'trivy');
    expect(trivy?.spdxId).toBe('AGPL-3.0');
    expect(trivy?.risk).toBe('review');
    expect(report.reviews).toContain('trivy@0.52.0');
    expect(report.blockers).not.toContain('trivy@0.52.0');
  });

  it('许可注册表应包含规格 §6.4 全部工具', () => {
    expect(TOOL_LICENSE_REGISTRY.trivy.spdxId).toBe('AGPL-3.0');
    expect(TOOL_LICENSE_REGISTRY.semgrep.spdxId).toBe('LGPL-2.1');
    expect(TOOL_LICENSE_REGISTRY.gitleaks.spdxId).toBe('MIT');
    expect(TOOL_LICENSE_REGISTRY.ort.spdxId).toBe('Apache-2.0');
    expect(TOOL_LICENSE_REGISTRY.grype.spdxId).toBe('Apache-2.0');
    expect(TOOL_LICENSE_REGISTRY.depcheck.spdxId).toBe('MIT');
    expect(TOOL_LICENSE_REGISTRY['dependency-cruiser'].spdxId).toBe('MIT');
    expect(TOOL_LICENSE_REGISTRY.jscpd.spdxId).toBe('MIT');
  });
});
