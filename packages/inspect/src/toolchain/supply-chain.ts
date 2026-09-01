import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import {
  TOOL_LICENSE_REGISTRY,
  TOOL_LOCKFILE_SCHEMA_VERSION,
  defaultToolBinDir,
  defaultToolLockfilePath,
  loadToolLockfile,
  saveToolLockfile,
} from '@zh/shared';
import type {
  LicenseAuditor,
  LicenseMatrixReport,
  ToolChannel,
  ToolInstallRecord,
  ToolLicense,
  ToolLockfile,
  ToolRequirement,
} from '@zh/shared';

// ─── 下载失败（全部渠道不可达，P0-3 分域降级消费） ────────────

export class ToolUnavailableError extends Error {
  constructor(
    readonly toolId: string,
    readonly attempts: { url: string; channel: ToolChannel; error: string }[],
    locale?: LanguageCode,
  ) {
    super(
      translate('engine.inspect.supplyChain.downloadAllFailed', locale ?? DEFAULT_LANGUAGE, {
        toolId,
        attempts: attempts.length,
      }),
    );
    this.name = 'ToolUnavailableError';
  }
}

export interface DownloadResult {
  data: Buffer;
  sourceUrl: string;
  channel: ToolChannel;
}

export interface ToolDownloader {
  /** 下载并返回字节；失败抛错，由调用方决定回退下一渠道 */
  download(url: string): Promise<Buffer>;
}

const defaultDownloader: ToolDownloader = {
  async download(url: string): Promise<Buffer> {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return Buffer.from(await res.arrayBuffer());
  },
};

function computeSha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface SupplyChainManagerOptions {
  lockfilePath?: string;
  binDir?: string;
  downloader?: ToolDownloader;
}

/**
 * 供应链锁管理器（08-商业化P0实现规格.md §6.3）
 * 方案 C：官方渠道自动供给 + sha256 校验 + 国内镜像回退
 */
export class SupplyChainManager {
  private lockfilePath: string;
  private binDir: string;
  private downloader: ToolDownloader;

  constructor(options: SupplyChainManagerOptions = {}) {
    this.lockfilePath = options.lockfilePath ?? defaultToolLockfilePath();
    this.binDir = options.binDir ?? defaultToolBinDir();
    this.downloader = options.downloader ?? defaultDownloader;
  }

  async getLockedRecord(toolId: string): Promise<ToolInstallRecord | null> {
    const lockfile = await loadToolLockfile(this.lockfilePath);
    return lockfile?.tools[toolId] ?? null;
  }

  /** 官方渠道 → sha256 比对 → 镜像回退 → 记录 lockfile */
  async ensureTool(req: ToolRequirement, locale?: LanguageCode): Promise<ToolInstallRecord> {
    const existing = await this.getLockedRecord(req.toolId);
    if (existing && existing.version === req.version) {
      const match = await this.verifyInstalledHash(req.toolId, existing.sha256);
      if (match) return existing;
    }

    const result = await this.downloadWithFallback(req, locale);
    const sha256 = computeSha256(result.data);
    if (req.expectedSha256 && sha256 !== req.expectedSha256) {
      throw new Error(
        translate('engine.inspect.supplyChain.sha256Mismatch', locale ?? DEFAULT_LANGUAGE, {
          toolId: req.toolId,
          expected: req.expectedSha256,
          actual: sha256,
        }),
      );
    }

    await this.installBinary(req.toolId, result.data);
    const record: ToolInstallRecord = {
      toolId: req.toolId,
      version: req.version,
      channel: result.channel,
      sha256,
      installedAt: new Date().toISOString(),
      sourceUrl: result.sourceUrl,
      signatureVerified: false,
    };
    await this.upsertRecord(record);
    return record;
  }

  /** 扫描中零外联保证：执行前校验已安装工具哈希，不匹配则拒绝运行 */
  async verifyBeforeRun(toolId: string): Promise<boolean> {
    const record = await this.getLockedRecord(toolId);
    if (!record) return false;
    return this.verifyInstalledHash(toolId, record.sha256);
  }

  /** 离线安装包（企业内网）：导入本地 tarball → 校验 → 入本地仓库 */
  async importOfflineBundle(toolId: string, bundlePath: string): Promise<ToolInstallRecord> {
    const data = await fs.readFile(bundlePath);
    const sha256 = computeSha256(data);
    await this.installBinary(toolId, data);
    const record: ToolInstallRecord = {
      toolId,
      version: 'offline',
      channel: 'mirror',
      sha256,
      installedAt: new Date().toISOString(),
      sourceUrl: `file://${bundlePath}`,
      signatureVerified: false,
    };
    await this.upsertRecord(record);
    return record;
  }

  getBinDir(): string {
    return this.binDir;
  }

  async binaryPath(toolId: string): Promise<string | null> {
    const p = path.join(this.binDir, toolId);
    try {
      await fs.access(p, fs.constants.X_OK);
      return p;
    } catch {
      return null;
    }
  }

  private async downloadWithFallback(
    req: ToolRequirement,
    locale?: LanguageCode,
  ): Promise<DownloadResult> {
    const sources: { url: string; channel: ToolChannel }[] = [];
    if (req.officialSource) sources.push({ url: req.officialSource, channel: 'official' });
    for (const url of req.mirrorSources ?? []) sources.push({ url, channel: 'mirror' });
    if (sources.length === 0) {
      throw new ToolUnavailableError(req.toolId, [], locale);
    }

    const attempts: { url: string; channel: ToolChannel; error: string }[] = [];
    for (const src of sources) {
      try {
        const data = await this.downloader.download(src.url);
        return { data, sourceUrl: src.url, channel: src.channel };
      } catch (err) {
        attempts.push({ url: src.url, channel: src.channel, error: String(err) });
      }
    }
    throw new ToolUnavailableError(req.toolId, attempts, locale);
  }

  private async installBinary(toolId: string, data: Buffer): Promise<void> {
    await fs.mkdir(this.binDir, { recursive: true });
    const p = path.join(this.binDir, toolId);
    await fs.writeFile(p, data, { mode: 0o755 });
  }

  private async verifyInstalledHash(toolId: string, expected: string): Promise<boolean> {
    try {
      const data = await fs.readFile(path.join(this.binDir, toolId));
      return computeSha256(data) === expected;
    } catch {
      return false;
    }
  }

  private async upsertRecord(record: ToolInstallRecord): Promise<void> {
    const lockfile: ToolLockfile = (await loadToolLockfile(this.lockfilePath)) ?? {
      schemaVersion: TOOL_LOCKFILE_SCHEMA_VERSION,
      tools: {},
    };
    lockfile.tools[record.toolId] = record;
    await saveToolLockfile(this.lockfilePath, lockfile);
  }
}

// ─── 许可审计（§6.3 / §6.4） ─────────────────────────────

export class LockfileLicenseAuditor implements LicenseAuditor {
  constructor(private readonly lockfilePath: string = defaultToolLockfilePath()) {}

  async audit(locale?: LanguageCode): Promise<LicenseMatrixReport> {
    const lockfile = await loadToolLockfile(this.lockfilePath);
    const entries = Object.entries(lockfile?.tools ?? {}) as [string, { version: string }][];
    const tools: (ToolLicense & { toolId: string; version: string })[] = entries.map(
      ([toolId, record]) => {
        const license: ToolLicense = TOOL_LICENSE_REGISTRY[toolId] ?? {
          spdxId: 'UNKNOWN',
          risk: 'block',
          redistributionNote: translate(
            'engine.inspect.supplyChain.unregisteredLicense',
            locale ?? DEFAULT_LANGUAGE,
          ),
        };
        return { ...license, toolId, version: record.version };
      },
    );
    return {
      tools,
      blockers: tools.filter((t) => t.risk === 'block').map((t) => `${t.toolId}@${t.version}`),
      reviews: tools.filter((t) => t.risk === 'review').map((t) => `${t.toolId}@${t.version}`),
    };
  }
}
