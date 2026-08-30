#!/usr/bin/env node
/**
 * install-tools.mjs — 智汇码盾外部工具安装脚本
 *
 * 用途:
 *   读取 scripts/tools.json 版本清单，探测本机缺失的外部工具并安装到
 *   ~/.zhshield/bin（用户级共享 bin 目录，CLI 与 desktop 共用）。
 *
 * 用法:
 *   node scripts/install-tools.mjs            # 探测并安装缺失工具
 *   node scripts/install-tools.mjs --check    # 只探测不安装（退出码 0=全可用，1=有缺失）
 *   node scripts/install-tools.mjs --force    # 强制重装（PATH 命中的工具仍跳过）
 *   node scripts/install-tools.mjs --help     # 帮助
 *
 * 目录约定:
 *   ~/.zhshield/bin/          二进制与 npm bin 软链（加入 PATH 即可被消费）
 *   ~/.zhshield/tools/<tool>/ npm 工具私有安装目录（npm install --prefix）
 *
 * 安装方式:
 *   - npm 工具: 安装到 ~/.zhshield/tools/<tool>，bin 软链到 ~/.zhshield/bin
 *     （Windows 软链失败时降级为写 .cmd 转发 shim）。版本探测优先读本地
 *     package.json；不支持 --version 的工具（如 ts-prune）在清单中标记
 *     versionFlag: false
 *   - binary 工具（github-release）: 按 tools.json 的 URL 模板下载官方 release
 *     资产，优先抓取官方 .sha256 checksum 文件核验，解压后 chmod +x 放入
 *     ~/.zhshield/bin
 *   - binary 工具（pypi，如 semgrep）: 官方不再发布 release 二进制，走
 *     pipx/uv tool install（bin 落到 ~/.zhshield/bin），pip --user 兜底
 *
 * 与 resolveToolCommand 的关系:
 *   packages/inspect/src/adapters/tool-bin.ts 的 resolveToolCommand 目前只查
 *   PATH + node_modules/.bin；把 ~/.zhshield/bin 纳入其查找范围是另一个独立
 *   任务。本脚本只保证目录约定明确、安装产物就位、输出清晰。
 *
 * 依赖: 仅 node 内置模块（node:fs/node:path/node:os/node:child_process/
 *        node:crypto/node:util），node 20+。
 */

import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';
import {
  mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync,
  symlinkSync, unlinkSync, copyFileSync, rmSync, readdirSync, statSync,
  mkdtempSync,
} from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { homedir, platform, arch, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(SCRIPT_DIR, 'tools.json');

const HOME = homedir();
const ZH_SHIELD_DIR = join(HOME, '.zhshield');
const BIN_DIR = join(ZH_SHIELD_DIR, 'bin');
const TOOLS_DIR = join(ZH_SHIELD_DIR, 'tools');

const IS_WIN = platform() === 'win32';

// ── 小工具 ────────────────────────────────────────────────────

function log(msg = '') {
  console.log(msg);
}

function warn(msg) {
  console.warn(`  \x1b[33m⚠ ${msg}\x1b[0m`);
}

function ok(msg) {
  console.log(`  \x1b[32m✓ ${msg}\x1b[0m`);
}

function fail(msg) {
  console.log(`  \x1b[31m✗ ${msg}\x1b[0m`);
}

/** 读取并校验 tools.json */
function readManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`install-tools: 清单不存在: ${MANIFEST_PATH}`);
    process.exit(2);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch (e) {
    console.error(`install-tools: tools.json 解析失败: ${e.message}`);
    process.exit(2);
  }
  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
    console.error('install-tools: tools.json 缺少 tools 数组');
    process.exit(2);
  }
  return manifest;
}

/** 工具在 PATH 中的可执行名（Windows 下 npm bin 为 .cmd） */
function binNameFor(tool) {
  if (tool.install === 'npm') return tool.npm.binName || tool.name;
  if (tool.install === 'binary') return tool.binary.binName || tool.name;
  return tool.name;
}

/** 探测 PATH（等价 command -v / where） */
function findInPath(binName) {
  if (IS_WIN) {
    const res = spawnSync('where', [binName], { encoding: 'utf-8' });
    if (res.status === 0 && res.stdout.trim()) return res.stdout.trim().split(/\r?\n/)[0];
    return null;
  }
  const res = spawnSync('sh', ['-c', `command -v ${binName}`], { encoding: 'utf-8' });
  if (res.status === 0 && res.stdout.trim()) return res.stdout.trim().split('\n')[0];
  return null;
}

/** 运行 <bin> --version 并提取首个 semver 三元组 */
function getToolVersion(binPath) {
  try {
    const res = spawnSync(binPath, ['--version'], { encoding: 'utf-8', timeout: 10000 });
    if (res.status !== 0) return null;
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    const m = out.match(/\d+\.\d+\.\d+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

function versionsMatch(actual, expected) {
  if (!actual || !expected) return false;
  return actual.replace(/^v/, '').trim() === expected.replace(/^v/, '').trim();
}

/** npm 工具本地安装版本：直接读 ~/.zhshield/tools/<tool>/node_modules/<pkg>/package.json */
function getNpmInstalledVersion(tool) {
  const pkgJson = join(TOOLS_DIR, tool.name, 'node_modules', tool.npm.package, 'package.json');
  try {
    return JSON.parse(readFileSync(pkgJson, 'utf-8')).version;
  } catch {
    return null;
  }
}

/** 工具是否支持 --version（ts-prune 等不支持，运行 --version 会触发分析） */
function supportsVersionFlag(tool) {
  if (tool.install === 'npm') return tool.npm.versionFlag !== false;
  return true;
}

/** 递归查找解压目录中的目标二进制 */
function findFileRecursive(dir, fileName) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      const found = findFileRecursive(p, fileName);
      if (found) return found;
    } else if (entry === fileName) {
      return p;
    }
  }
  return null;
}

/** 下载文件到本地（GitHub CDN 会拒绝 undici 默认 UA，必须带 User-Agent） */
async function downloadFile(url, dest) {
  const buf = await downloadBuffer(url);
  writeFileSync(dest, buf);
}

/** 下载字节：fetch（重试）→ https.request → curl 兜底 */
async function downloadBuffer(url) {
  try {
    return await fetchWithRetry(url);
  } catch (e) {
    warn(`fetch 失败（${e.message}），改用 https.request 下载`);
  }
  try {
    return await httpRequest(url);
  } catch (e) {
    warn(`https.request 失败（${e.message}），改用 curl 下载`);
  }
  return curlDownload(url);
}

/** curl 下载（本机网络对 Node HTTP 栈不稳定，curl 最可靠） */
function curlDownload(url) {
  const res = spawnSync('curl', ['-fsSL', '--max-time', '300', url], {
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`curl 下载失败（exit ${res.status}）: ${(res.stderr || '').toString().trim()}`);
  }
  return res.stdout;
}

/** fetch + 重试（本机网络对 github.com 连接不稳定，undici 10s 连接超时偏短） */
async function fetchWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'zhshield-install/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

/** 经典 https.request 下载（跟随重定向），作为 fetch 的兜底 */
function httpRequest(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? httpsGet : httpGet;
    const req = mod(url, { headers: { 'User-Agent': 'zhshield-install/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        httpRequest(next, redirects - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage}: ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('请求超时')));
  });
}

/** 计算文件 sha256 */
function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/** 从官方 checksum 文件中解析目标文件的 sha256（格式: <hash>  <filename>） */
function parseChecksum(text, fileName) {
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === fileName) return parts[0];
  }
  return null;
}

/** 把 npm 工具 bin 软链到 ~/.zhshield/bin（Windows 降级为 .cmd 转发 shim） */
function linkBin(shimPath, binName) {
  mkdirSync(BIN_DIR, { recursive: true });
  const targetName = IS_WIN ? `${binName}.cmd` : binName;
  const target = join(BIN_DIR, targetName);
  try { unlinkSync(target); } catch { /* 不存在则忽略 */ }

  if (IS_WIN) {
    // 转发 shim：调用 tools 目录下 npm 生成的 .cmd（其内部 %~dp0 相对路径仍正确）
    const rel = relative(BIN_DIR, shimPath).replace(/\//g, '\\');
    writeFileSync(target, `@echo off\r\n"%~dp0${rel}" %*\r\n`);
    return;
  }
  try {
    symlinkSync(shimPath, target);
  } catch (e) {
    // 软链失败（如跨设备）降级为拷贝
    warn(`${binName}: 软链失败（${e.message}），降级为拷贝`);
    copyFileSync(shimPath, target);
    chmodSync(target, 0o755);
  }
}

// ── 安装器 ────────────────────────────────────────────────────

/** npm 工具: npm install --prefix ~/.zhshield/tools/<tool>，bin 软链 */
function installNpmTool(tool) {
  const pkg = tool.npm.package;
  const binName = tool.npm.binName || tool.name;
  const toolDir = join(TOOLS_DIR, tool.name);
  const spec = `${pkg}@${tool.version}`;

  mkdirSync(toolDir, { recursive: true });
  const res = spawnSync('npm', [
    'install', '--prefix', toolDir,
    '--no-save', '--no-audit', '--no-fund', '--no-package-lock',
    spec,
  ], { encoding: 'utf-8', stdio: 'inherit' });
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

/** binary 工具（github-release）: 下载 → 校验 → 解压 → chmod +x → 放入 bin */
async function installGithubReleaseTool(tool) {
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

  const tmpDir = mkdtempSync(join(tmpdir(), 'zhshield-'));
  try {
    const archivePath = join(tmpDir, fileName);
    log(`    下载 ${url}`);
    await downloadFile(url, archivePath);

    // 校验和
    let verified = false;
    if (checksumUrl) {
      try {
        const checksumText = (await downloadBuffer(checksumUrl)).toString('utf-8');
        const expected = parseChecksum(checksumText, fileName);
        if (expected) {
          const actual = sha256File(archivePath);
          if (actual !== expected) {
            throw new Error(`sha256 不匹配: ${fileName}\n  期望 ${expected}\n  实际 ${actual}`);
          }
          verified = true;
          ok(`${tool.name}: sha256 校验通过`);
        } else {
          warn(`${tool.name}: checksum 文件中未找到 ${fileName} 条目，结果标记为 unverified`);
        }
      } catch (e) {
        warn(`${tool.name}: 无法获取/解析 checksum（${e.message}），结果标记为 unverified`);
      }
    } else {
      warn(`${tool.name}: 清单未提供 checksum 模板，结果标记为 unverified`);
    }

    // 解压（.zip 用 bsdtar，win32/macOS 均自带；.tar.gz 用 GNU/bsd tar）
    const extractDir = join(tmpDir, 'extract');
    mkdirSync(extractDir, { recursive: true });
    const tarArgs = ext === 'zip' ? ['-xf', archivePath, '-C', extractDir] : ['-xzf', archivePath, '-C', extractDir];
    const tarRes = spawnSync('tar', tarArgs, { encoding: 'utf-8', stdio: 'inherit' });
    if (tarRes.status !== 0) {
      throw new Error(`解压失败: ${fileName}`);
    }

    const exeName = IS_WIN ? `${bin.binName}.exe` : bin.binName;
    const found = findFileRecursive(extractDir, exeName);
    if (!found) {
      throw new Error(`解压后未找到二进制 ${exeName}`);
    }

    mkdirSync(BIN_DIR, { recursive: true });
    const target = join(BIN_DIR, exeName);
    copyFileSync(found, target);
    chmodSync(target, 0o755);
    return { verified };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** binary 工具（pypi，如 semgrep）: pipx/uv tool install → bin 落 ~/.zhshield/bin，pip --user 兜底 */
function installPypiTool(tool) {
  const bin = tool.binary;
  const spec = `${bin.pypiPackage}==${tool.version}`;

  if (findInPath('pipx')) {
    log(`    pipx install ${spec}（PIPX_BIN_DIR=${BIN_DIR}）`);
    const res = spawnSync('pipx', ['install', spec], {
      env: { ...process.env, PIPX_BIN_DIR: BIN_DIR },
      encoding: 'utf-8', stdio: 'inherit',
    });
    if (res.status === 0) return { verified: true };
    warn(`pipx 安装失败（exit ${res.status}），尝试 uv`);
  }
  if (findInPath('uv')) {
    log(`    uv tool install ${spec}（UV_TOOL_BIN_DIR=${BIN_DIR}）`);
    const res = spawnSync('uv', ['tool', 'install', spec], {
      env: { ...process.env, UV_TOOL_BIN_DIR: BIN_DIR },
      encoding: 'utf-8', stdio: 'inherit',
    });
    if (res.status === 0) return { verified: true };
    warn(`uv 安装失败（exit ${res.status}），尝试 pip --user`);
  }
  // 兜底: pip --user（二进制落在 ~/.local/bin，不在 ~/.zhshield/bin）
  const res = spawnSync('python3', ['-m', 'pip', 'install', '--user', spec], {
    encoding: 'utf-8', stdio: 'inherit',
  });
  if (res.status !== 0) {
    throw new Error(`pip install ${spec} 失败（exit ${res.status}）`);
  }
  warn(`${tool.name}: 通过 pip --user 安装，二进制位于 ~/.local/bin（不在 ~/.zhshield/bin）`);
  return { verified: false };
}

/** 按工具类型分发安装 */
async function installTool(tool) {
  if (tool.install === 'npm') return installNpmTool(tool);
  if (tool.install === 'binary') {
    if (tool.binary.downloadSource === 'pypi') return installPypiTool(tool);
    return installGithubReleaseTool(tool);
  }
  throw new Error(`未知 install 类型: ${tool.install}`);
}

// ── 主流程 ────────────────────────────────────────────────────

function printHelp() {
  log(`install-tools — 智汇码盾外部工具安装脚本

用法:
  node scripts/install-tools.mjs            # 探测并安装缺失工具
  node scripts/install-tools.mjs --check    # 只探测不安装（退出码 0=全可用，1=有缺失）
  node scripts/install-tools.mjs --force    # 强制重装（PATH 命中的工具仍跳过）
  node scripts/install-tools.mjs --help     # 帮助

目录约定:
  ~/.zhshield/bin/          二进制与 npm bin 软链（加入 PATH 即可被消费）
  ~/.zhshield/tools/<tool>/ npm 工具私有安装目录

说明:
  工具版本清单见 scripts/tools.json；安装入口与报告层提示一致（zhshield tools install）。`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const manifest = readManifest();
  const tools = manifest.tools;

  log(`[zhshield tools] 清单: ${tools.length} 个工具（${manifest.checked} 校验）`);
  log(`[zhshield tools] bin 目录: ${BIN_DIR}`);
  if (values.check) log('[zhshield tools] --check 模式：只探测不安装');
  if (values.force) log('[zhshield tools] --force 模式：强制重装');
  log('');

  const rows = [];
  let installedCount = 0;
  let missingCount = 0;

  for (const tool of tools) {
    const binName = binNameFor(tool);
    const label = `${tool.name.padEnd(12)} ${String(tool.version).padEnd(9)}`;

    // 内置工具（项目自身依赖提供，无需安装）
    if (tool.install === 'builtin') {
      rows.push({ tool, status: 'builtin' });
      log(`  - ${label} 内置（项目依赖提供，跳过）`);
      continue;
    }

    // 1) PATH 命中（PATH 工具由用户管理，--force 也不重装）
    const pathHit = findInPath(binName);
    if (pathHit) {
      if (supportsVersionFlag(tool)) {
        const actual = getToolVersion(pathHit);
        if (actual && versionsMatch(actual, tool.version)) {
          rows.push({ tool, status: 'path' });
          ok(`${label} 可用（PATH: ${pathHit}）`);
        } else {
          rows.push({ tool, status: 'path' });
          warn(`${label} PATH 命中但版本不符（${actual || '未知'} ≠ ${tool.version}），PATH 工具由用户管理，跳过`);
        }
      } else {
        rows.push({ tool, status: 'path' });
        ok(`${label} 可用（PATH: ${pathHit}）`);
      }
      continue;
    }

    // 2) ~/.zhshield/bin 命中
    const localBin = join(BIN_DIR, IS_WIN ? `${binName}.cmd` : binName);
    if (existsSync(localBin) && !values.force) {
      const actual = tool.install === 'npm' ? getNpmInstalledVersion(tool) : getToolVersion(localBin);
      if (actual && versionsMatch(actual, tool.version)) {
        rows.push({ tool, status: 'local' });
        ok(`${label} 可用（${localBin}）`);
        continue;
      }
      warn(`${label} 本地版本不符（${actual || '未知'} ≠ ${tool.version}），重装`);
    }

    // 3) 缺失 → 安装（或 --check 只报告）
    if (values.check) {
      rows.push({ tool, status: 'missing' });
      missingCount++;
      fail(`${label} 缺失`);
      continue;
    }

    log(`  → ${label} 安装中...`);
    try {
      const r = await installTool(tool);
      rows.push({ tool, status: 'installed', verified: r?.verified });
      installedCount++;
      ok(`${label} 已安装到 ${BIN_DIR}${r?.verified === false ? '（unverified）' : ''}`);
    } catch (e) {
      rows.push({ tool, status: 'error' });
      missingCount++;
      fail(`${label} 安装失败: ${e.message}`);
    }
  }

  // ── 汇总 ──
  log('');
  const byStatus = (s) => rows.filter((r) => r.status === s).length;
  const available = byStatus('path') + byStatus('local') + byStatus('builtin');
  log(`[zhshield tools] 汇总: ${available} 可用 / ${installedCount} 新安装 / ${missingCount} 缺失或失败`);

  if (values.check) {
    log(missingCount === 0
      ? '[zhshield tools] 全部工具可用。'
      : `[zhshield tools] ${missingCount} 个工具缺失，请运行 node scripts/install-tools.mjs 安装。`);
    process.exit(missingCount > 0 ? 1 : 0);
  }

  if (installedCount > 0) {
    log(`已将 ${installedCount} 个工具安装到 ${BIN_DIR}，请将其加入 PATH（或使用 zhshield tools install 的等效入口）`);
  } else if (missingCount === 0) {
    log('无需安装：全部工具已可用。');
  } else {
    log(`有 ${missingCount} 个工具安装失败，请检查上方错误信息后重试。`);
  }
}

// 直接执行时运行 main（被 import 时仅暴露函数，便于测试）
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().catch((e) => {
    console.error('install-tools: 错误:', e.message);
    process.exit(2);
  });
}

// 导出供测试/复用
export {
  readManifest, binNameFor, findInPath, getToolVersion, getNpmInstalledVersion,
  versionsMatch, supportsVersionFlag, linkBin, downloadFile, downloadBuffer,
  fetchWithRetry, httpRequest, curlDownload, parseChecksum, sha256File,
  installNpmTool, installGithubReleaseTool, installPypiTool, installTool,
  BIN_DIR, TOOLS_DIR,
};