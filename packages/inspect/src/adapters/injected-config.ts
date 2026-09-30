/**
 * injected-config.ts — SOP 规则声明的工具配置文件路径解析（含回退链）
 *
 * 规则声明的 config 路径多为仓库内部相对路径（如
 * node_modules/@zh/kernel/dist/assets/eslint/eslint-performance.config.mjs），
 * 仅在目标项目安装了对应依赖时按 cwd 解析才存在。本模块提供统一的回退解析：
 *   1. 相对 cwd（被扫描目录）解析
 *   2. 相对项目根解析
 *   3. 路径含 @zh/kernel/ 前缀时，定位 kernel 包安装位置后按包内路径解析
 * 全部不存在时返回 null，由调用方决定退化为 skipped（而非硬错误）。
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 判断文件是否存在（不可读时按不存在处理） */
function isFile(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 尝试从 paths 中定位 @zh/kernel 包根目录，失败返回 null */
function locateKernelPackageRoot(paths: string[]): string | null {
  // 锚点文件仅需合法格式（inspect 以 CJS 编译，不能用 import.meta.url）。
  // 锚定 projectPath，不受 cwd 影响（09-12 复验修复）：createRequire 锚点改为
  // __dirname（本模块所在目录），不再依赖 process.cwd()。
  const require = createRequire(path.join(__dirname, 'package.json'));
  for (const base of paths) {
    if (!base) continue;
    try {
      const pkgJsonPath = require.resolve('@zh/kernel/package.json', { paths: [base] });
      return path.dirname(pkgJsonPath);
    } catch {
      // 该 base 下不可解析，继续
    }
  }
  return null;
}

/**
 * 解析规则注入的配置文件路径：
 * 依次按 cwd、项目根、@zh/kernel 包内路径回退，全部缺失返回 null。
 */
export function resolveInjectedConfigPath(
  config: string,
  cwd: string,
  projectPath: string,
): string | null {
  return (
    resolveByCwd(config, cwd) ??
    resolveByProject(config, projectPath) ??
    resolveKernelAsset(config, cwd, projectPath)
  );
}

/** 1. 相对被扫描目录（ESLint v9 以 cwd 查找配置） */
function resolveByCwd(config: string, cwd: string): string | null {
  const byCwd = path.resolve(cwd, config);
  if (isFile(byCwd)) return byCwd;
  return null;
}

/** 2. 相对项目根 */
function resolveByProject(config: string, projectPath: string): string | null {
  const byProject = path.resolve(projectPath, config);
  if (isFile(byProject)) return byProject;
  return null;
}

/** 3. 仓库内部资产：定位 @zh/kernel 包后按包内相对路径解析 */
function resolveKernelAsset(config: string, cwd: string, projectPath: string): string | null {
  const inPackageRelPath = extractKernelRelPath(config);
  if (inPackageRelPath === null) return null;

  const candidates = buildKernelRootCandidates(cwd, projectPath);
  return findKernelAsset(candidates, inPackageRelPath);
}

/** 从 config 中提取 @zh/kernel/ 前缀后的包内相对路径；非 kernel 资产返回 null */
function extractKernelRelPath(config: string): string | null {
  const kernelPrefix = '@zh/kernel/';
  if (!config.includes(kernelPrefix)) return null;
  return config.split(kernelPrefix)[1];
}

/**
 * 候选 kernel 包根（按顺序尝试，任一命中即返回）：
 *   a) require.resolve 命中的实际安装位置（桌面端 Electron：node_modules 内有 @zh/kernel）
 *   b) 扫描目标自身是 monorepo 根 → <projectPath>/packages/kernel
 *   c) 按本模块所在目录逐级回溯仓库内 packages/kernel
 *
 * 为什么需要 c)：CLI 把 @zh/* 的**源码** bundle 成单文件（build-cli.mjs 解析到
 * src/index.ts），但 `packages/cli` 的 package.json **未声明** @zh/kernel 依赖，
 * 运行时 node_modules 里不存在该包 ⇒ a) 必然 MODULE_NOT_FOUND，b) 在扫描子目录时
 * （projectPath = <repo>/packages/cli）也落空。此时只能按目录层级回溯。
 * 2026-09-22：此缺口曾使「规则声明 config 引用内核资产」在 CLI 链路静默退化为
 * skipped（表现为「Semgrep 配置不存在，跳过该规则」），而桌面端正常 ⇒ 同一规则
 * 两入口行为不一致。
 */
function buildKernelRootCandidates(cwd: string, projectPath: string): Array<string | null> {
  return [
    locateKernelPackageRoot([cwd, projectPath, __dirname]),
    path.join(projectPath, 'packages', 'kernel'),
    inferMonorepoKernelRoot(__dirname),
  ];
}

/** 在候选 kernel 根中查找包内资产，命中即返回绝对路径 */
function findKernelAsset(
  candidates: Array<string | null>,
  inPackageRelPath: string,
): string | null {
  for (const root of candidates) {
    if (!root) continue;
    if (!isFile(path.join(root, 'package.json'))) continue;
    const inKernel = path.join(root, inPackageRelPath);
    if (isFile(inKernel)) return inKernel;
  }
  return null;
}

/**
 * 从给定目录逐级向上寻找 monorepo 内的 `packages/kernel`。
 * 用于 CLI bundle 场景（node_modules 无 @zh/kernel，只能按目录位置推断）。
 */
function inferMonorepoKernelRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const pkgJson = path.join(dir, 'packages', 'kernel', 'package.json');
    if (isFile(pkgJson)) return path.dirname(pkgJson);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
