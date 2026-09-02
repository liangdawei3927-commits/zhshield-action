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
  // 锚点文件仅需合法格式（inspect 以 CJS 编译，不能用 import.meta.url）
  const require = createRequire(path.join(process.cwd(), 'package.json'));
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
  // 1. 相对被扫描目录（ESLint v9 以 cwd 查找配置）
  const byCwd = path.resolve(cwd, config);
  if (isFile(byCwd)) return byCwd;

  // 2. 相对项目根
  const byProject = path.resolve(projectPath, config);
  if (isFile(byProject)) return byProject;

  // 3. 仓库内部资产：定位 @zh/kernel 包后按包内相对路径解析
  const kernelPrefix = '@zh/kernel/';
  if (config.includes(kernelPrefix)) {
    const kernelRoot = locateKernelPackageRoot([cwd, projectPath, process.cwd(), __dirname]);
    if (kernelRoot) {
      const inKernel = path.join(kernelRoot, config.split(kernelPrefix)[1]);
      if (isFile(inKernel)) return inKernel;
    }
  }

  return null;
}
