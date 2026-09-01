import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { translate, DEFAULT_LANGUAGE } from '@zh/i18n';

// ─── 供应链锁数据契约（08-商业化P0实现规格.md §6.2） ─────────────

export type ToolChannel = 'official' | 'mirror';

export interface ToolLicense {
  spdxId: string;
  risk: 'low' | 'review' | 'block';
  redistributionNote: string;
}

export interface ToolInstallRecord {
  toolId: string;
  version: string;
  channel: ToolChannel;
  sha256: string;
  installedAt: string;
  sourceUrl: string;
  signatureVerified: boolean;
}

export interface ToolLockfile {
  schemaVersion: number;
  tools: Record<string, ToolInstallRecord>;
}

export interface ToolRequirement {
  toolId: string;
  version: string;
  expectedSha256?: string;
  officialSource?: string;
  mirrorSources?: string[];
}

export interface LicenseMatrixReport {
  tools: (ToolLicense & { toolId: string; version: string })[];
  blockers: string[];
  reviews: string[];
}

export interface LicenseAuditor {
  audit(): Promise<LicenseMatrixReport>;
}

// ─── 许可注册表（08 文档 §6.4 权威矩阵，Trivy 已回写 AGPL-3.0） ──

export const TOOL_LICENSE_REGISTRY: Record<string, ToolLicense> = {
  trivy: {
    spdxId: 'AGPL-3.0',
    risk: 'review',
    redistributionNote: translate(
      'engine.toolchain.license.trivyRedistributionNote',
      DEFAULT_LANGUAGE,
    ),
  },
  semgrep: {
    spdxId: 'LGPL-2.1',
    risk: 'review',
    redistributionNote: translate(
      'engine.toolchain.license.semgrepRedistributionNote',
      DEFAULT_LANGUAGE,
    ),
  },
  gitleaks: { spdxId: 'MIT', risk: 'low', redistributionNote: '' },
  jscpd: { spdxId: 'MIT', risk: 'low', redistributionNote: '' },
  depcheck: { spdxId: 'MIT', risk: 'low', redistributionNote: '' },
  'dependency-cruiser': { spdxId: 'MIT', risk: 'low', redistributionNote: '' },
  ort: {
    spdxId: 'Apache-2.0',
    risk: 'low',
    redistributionNote: translate(
      'engine.toolchain.license.ortRedistributionNote',
      DEFAULT_LANGUAGE,
    ),
  },
  grype: { spdxId: 'Apache-2.0', risk: 'low', redistributionNote: '' },
};

export const TOOL_LOCKFILE_SCHEMA_VERSION = 1;

export function defaultToolLockfilePath(): string {
  return path.join(os.homedir(), '.zhshield', 'tool-lockfile.json');
}

export function defaultToolBinDir(): string {
  return path.join(os.homedir(), '.zhshield', 'bin');
}

export async function loadToolLockfile(filePath: string): Promise<ToolLockfile | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as ToolLockfile;
  } catch {
    return null;
  }
}

export async function saveToolLockfile(filePath: string, lockfile: ToolLockfile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(lockfile, null, 2), 'utf-8');
}
