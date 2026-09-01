/**
 * installers.mjs — 各安装方式的实现与分发
 *
 * 安装方式:
 *   - npm: 安装到 ~/.zhshield/tools/<tool>，bin 软链到 ~/.zhshield/bin
 *   - binary（github-release）: 按 URL 模板下载官方 release 资产，sha256 校验，
 *     解压后 chmod +x 放入 ~/.zhshield/bin
 *   - binary（pypi，如 semgrep）: pipx/uv tool install（bin 落 ~/.zhshield/bin），
 *     pip --user 兜底
 *
 * 依赖: 仅 node 内置模块（node:fs/node:path/node:os/node:child_process），node 20+。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, copyFileSync, chmodSync, rmSync, mkdtempSync } from 'node:fs';
import { join, basename } from 'node:path';
import { platform, arch, tmpdir } from 'node:os';
import { BIN_DIR, TOOLS_DIR, IS_WIN, log, warn, ok } from './constants.mjs';
import { findInPath, findFileRecursive } from './detect.mjs';
import { downloadFile, downloadBuffer, sha256File, parseChecksum } from './download.mjs';
import { linkBin } from './link.mjs';

/** npm 工具: npm install --prefix ~/.zhshield/tools/<tool>，bin 软链 */
export function installNpmTool(tool) {
  const pkg = tool.npm.package;
  const binName = tool.npm.binName || tool.name;
  const toolDir = join(TOOLS_DIR, tool.name);
  const spec = `${pkg}@${tool.version}`;

  mkdirSync(toolDir, { recursive: true });
  const res = spawnSync(
    'npm',
    [
      'install',
      '--prefix',
      toolDir,
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      spec,
    ],
    { encoding: 'utf-8', stdio: 'inherit' },
  );
  if (res.status !== 0) {
    throw new Error(`npm install ${spec} 失败（exit ${res.status}）`);
  }

  const shim = join(toolDir, 'node_modules', '.bin', IS_WIN ? `${binName}.cmd` : binName);
  if (!existsSync(shim)) {
    throw new Error(`安装后未找到 bin: ${shim}`);
  }
  linkBin(shim, binName);
  return { verified: true };
}

/** 解析 github-release 资产信息（os/arch 映射、URL 模板、checksum 模板） */
function resolveAssetInfo(tool) {
  const bin = tool.binary;
  const osKey = bin.osMap?.[platform()];
  const archKey = bin.archMap?.[arch()];
  if (!osKey || !archKey) {
    throw new Error(`官方未发布 ${platform()}/${arch()} 资产`);
  }
  if (Array.isArray(bin.unsupported) && bin.unsupported.includes(`${platform()}/${arch()}`)) {
    throw new Error(`官方未发布 ${platform()}/${arch()} 资产（清单标记 unsupported）`);
  }
  const ext = bin.extMap?.[platform()] || bin.archive || 'tar.gz';
  const url = bin.urlTemplate
    .replaceAll('{version}', tool.version)
    .replaceAll('{os}', osKey)
    .replaceAll('{arch}', archKey)
    .replaceAll('{ext}', ext);
  const fileName = basename(url);
  const checksumUrl = bin.checksumTemplate?.replaceAll('{version}', tool.version);
  return { ext, url, fileName, checksumUrl };
}

/** 下载并核验官方 checksum（缺失/解析失败/不匹配均标记 unverified，不中断安装） */
async function verifyChecksum(tool, fileName, checksumUrl, archivePath) {
  if (!checksumUrl) {
    warn(`${tool.name}: 清单未提供 checksum 模板，结果标记为 unverified`);
    return false;
  }
  try {
    const checksumText = (await downloadBuffer(checksumUrl)).toString('utf-8');
    const expected = parseChecksum(checksumText, fileName);
    if (!expected) {
      warn(`${tool.name}: checksum 文件中未找到 ${fileName} 条目，结果标记为 unverified`);
      return false;
    }
    const actual = sha256File(archivePath);
    if (actual !== expected) {
      throw new Error(`sha256 不匹配: ${fileName}\n  期望 ${expected}\n  实际 ${actual}`);
    }
    ok(`${tool.name}: sha256 校验通过`);
    return true;
  } catch (e) {
    warn(`${tool.name}: 无法获取/解析 checksum（${e.message}），结果标记为 unverified`);
    return false;
  }
}

/** 解压归档（.zip 用 bsdtar，win32/macOS 均自带；.tar.gz 用 GNU/bsd tar） */
function extractArchive(archivePath, extractDir, ext, fileName) {
  mkdirSync(extractDir, { recursive: true });
  const tarArgs =
    ext === 'zip'
      ? ['-xf', archivePath, '-C', extractDir]
      : ['-xzf', archivePath, '-C', extractDir];
  const tarRes = spawnSync('tar', tarArgs, { encoding: 'utf-8', stdio: 'inherit' });
  if (tarRes.status !== 0) {
    throw new Error(`解压失败: ${fileName}`);
  }
}

/** 把解压出的二进制拷贝到 ~/.zhshield/bin 并 chmod +x */
function installBinaryToBin(found, exeName) {
  mkdirSync(BIN_DIR, { recursive: true });
  const target = join(BIN_DIR, exeName);
  copyFileSync(found, target);
  chmodSync(target, 0o755);
}

/** binary 工具（github-release）: 下载 → 校验 → 解压 → chmod +x → 放入 bin */
export async function installGithubReleaseTool(tool) {
  const { ext, url, fileName, checksumUrl } = resolveAssetInfo(tool);
  const tmpDir = mkdtempSync(join(tmpdir(), 'zhshield-'));
  try {
    const archivePath = join(tmpDir, fileName);
    log(`    下载 ${url}`);
    await downloadFile(url, archivePath);
    const verified = await verifyChecksum(tool, fileName, checksumUrl, archivePath);
    const extractDir = join(tmpDir, 'extract');
    extractArchive(archivePath, extractDir, ext, fileName);
    const exeName = IS_WIN ? `${tool.binary.binName}.exe` : tool.binary.binName;
    const found = findFileRecursive(extractDir, exeName);
    if (!found) throw new Error(`解压后未找到二进制 ${exeName}`);
    installBinaryToBin(found, exeName);
    return { verified };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** binary 工具（pypi，如 semgrep）: pipx/uv tool install → bin 落 ~/.zhshield/bin，pip --user 兜底 */
export function installPypiTool(tool) {
  const bin = tool.binary;
  const spec = `${bin.pypiPackage}==${tool.version}`;

  if (findInPath('pipx')) {
    log(`    pipx install ${spec}（PIPX_BIN_DIR=${BIN_DIR}）`);
    const res = spawnSync('pipx', ['install', spec], {
      env: { ...process.env, PIPX_BIN_DIR: BIN_DIR },
      encoding: 'utf-8',
      stdio: 'inherit',
    });
    if (res.status === 0) return { verified: true };
    warn(`pipx 安装失败（exit ${res.status}），尝试 uv`);
  }
  if (findInPath('uv')) {
    log(`    uv tool install ${spec}（UV_TOOL_BIN_DIR=${BIN_DIR}）`);
    const res = spawnSync('uv', ['tool', 'install', spec], {
      env: { ...process.env, UV_TOOL_BIN_DIR: BIN_DIR },
      encoding: 'utf-8',
      stdio: 'inherit',
    });
    if (res.status === 0) return { verified: true };
    warn(`uv 安装失败（exit ${res.status}），尝试 pip --user`);
  }
  // 兜底: pip --user（二进制落在 ~/.local/bin，不在 ~/.zhshield/bin）
  const res = spawnSync('python3', ['-m', 'pip', 'install', '--user', spec], {
    encoding: 'utf-8',
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    throw new Error(`pip install ${spec} 失败（exit ${res.status}）`);
  }
  warn(`${tool.name}: 通过 pip --user 安装，二进制位于 ~/.local/bin（不在 ~/.zhshield/bin）`);
  return { verified: false };
}

/** 按工具类型分发安装 */
export async function installTool(tool) {
  if (tool.install === 'npm') return installNpmTool(tool);
  if (tool.install === 'binary') {
    if (tool.binary.downloadSource === 'pypi') return installPypiTool(tool);
    return installGithubReleaseTool(tool);
  }
  throw new Error(`未知 install 类型: ${tool.install}`);
}
