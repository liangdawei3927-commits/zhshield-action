/**
 * PATH 补全模块
 *
 * GUI 场景（macOS Electron / 编辑器派生的 MCP server）继承的 PATH 往往只有
 * /usr/bin:/bin 等系统目录，nvm / Homebrew / pipx / ~/.local/bin 安装的
 * CLI 工具（eslint、semgrep、trivy、gitleaks 等）无法被 execFile 探测到，
 * 导致误报"工具未安装"。在进程最早期调用本模块补齐搜索路径。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

let _augmented = false;

export function augmentProcessPath(workspaceStartDir?: string): void {
  if (_augmented) return;
  _augmented = true;

  const existingPath = process.env.PATH ?? '';
  const toPrepend = collectPrependDirs(workspaceStartDir ?? process.cwd(), existingPath);

  if (toPrepend.length > 0) {
    process.env.PATH = [...toPrepend, existingPath].join(path.delimiter);
  }
}

function collectPrependDirs(workspaceStartDir: string, existingPath: string): string[] {
  const existingDirs = new Set(
    existingPath.split(path.delimiter).filter((d) => d.length > 0),
  );
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';

  const toPrepend: string[] = [];
  // 自定义 bin 目录（最高优先级）
  toPrepend.push(...collectCustomBin(home, existingDirs));
  toPrepend.push(...collectWorkspaceBin(workspaceStartDir, existingDirs));
  // Homebrew（Apple Silicon + Intel）
  toPrepend.push(...collectHomebrewBins(existingDirs));
  toPrepend.push(...collectLocalBin(home, existingDirs));
  // nvm：所有已安装 Node 版本的 bin，按版本降序 push 使高版本优先级更高
  toPrepend.push(...collectNvmBinsFromHome(home, existingDirs));
  return toPrepend;
}

function collectCustomBin(home: string, existingDirs: Set<string>): string[] {
  if (!home) return [];
  const zhBin = path.join(home, '.zhshield', 'bin');
  if (fs.existsSync(zhBin) && !existingDirs.has(zhBin)) {
    return [zhBin];
  }
  return [];
}

function collectWorkspaceBin(workspaceStartDir: string, existingDirs: Set<string>): string[] {
  const workspaceBin = findWorkspaceNodeModulesBin(workspaceStartDir, 3);
  if (workspaceBin && !existingDirs.has(workspaceBin)) {
    return [workspaceBin];
  }
  return [];
}

function collectHomebrewBins(existingDirs: Set<string>): string[] {
  const bins: string[] = [];
  for (const brewBin of ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']) {
    if (fs.existsSync(brewBin) && !existingDirs.has(brewBin)) {
      bins.push(brewBin);
    }
  }
  return bins;
}

function collectLocalBin(home: string, existingDirs: Set<string>): string[] {
  if (!home) return [];
  const localBin = path.join(home, '.local', 'bin');
  if (fs.existsSync(localBin) && !existingDirs.has(localBin)) {
    return [localBin];
  }
  return [];
}

function collectNvmBinsFromHome(home: string, existingDirs: Set<string>): string[] {
  if (!home) return [];
  const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
  if (fs.existsSync(nvmVersionsDir)) {
    return collectNvmBins(nvmVersionsDir, existingDirs);
  }
  return [];
}

function findWorkspaceNodeModulesBin(startDir: string, maxLevels: number): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i <= maxLevels; i++) {
    const candidate = path.join(dir, 'node_modules', '.bin');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function collectNvmBins(nvmVersionsDir: string, existingDirs: Set<string>): string[] {
  const versionDirs = listNvmVersionDirs(nvmVersionsDir);
  const sorted = sortNvmVersionsDesc(versionDirs);
  return collectExistingBins(nvmVersionsDir, sorted, existingDirs);
}

/** 列出 nvm 版本目录（忽略不可读项） */
function listNvmVersionDirs(nvmVersionsDir: string): string[] {
  try {
    return fs.readdirSync(nvmVersionsDir).filter((name) => {
      try {
        return fs.statSync(path.join(nvmVersionsDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** 按版本号降序排序（v 前缀忽略，数值比较） */
function sortNvmVersionsDesc(versionDirs: string[]): string[] {
  return [...versionDirs].sort((a, b) => {
    const va = a.startsWith('v') ? a.slice(1) : a;
    const vb = b.startsWith('v') ? b.slice(1) : b;
    return vb.localeCompare(va, undefined, { numeric: true, sensitivity: 'base' });
  });
}

/** 收集已存在且未在 PATH 中的版本 bin 目录 */
function collectExistingBins(
  nvmVersionsDir: string,
  versionDirs: string[],
  existingDirs: Set<string>,
): string[] {
  const bins: string[] = [];
  for (const ver of versionDirs) {
    const bin = path.join(nvmVersionsDir, ver, 'bin');
    if (fs.existsSync(bin) && !existingDirs.has(bin)) {
      bins.push(bin);
    }
  }
  return bins;
}
