import * as fs from 'node:fs';
import * as path from 'node:path';

const WHITESPACE = /\s+/;

/**
 * 探测测试命令：读取 package.json 中的 test 脚本并拆分为命令与参数，
 * 同时在嵌套仓库中定位含 test 脚本的项目目录。
 */
export class TestCommandDetector {
  /** 解析实际项目目录：projectPath 无 package.json 时向下查找含 test 脚本的一层子目录（嵌套仓库，如 zhiyan-codeshield/） */
  resolveProjectDir(projectPath: string): { dir: string } | { error: string } {
    const pkg = this.loadPackageJson(projectPath);
    if (!('error' in pkg)) return { dir: projectPath };

    const entries = fs.existsSync(projectPath) ? fs.readdirSync(projectPath) : [];
    for (const entry of entries) {
      if (entry === 'node_modules') continue;
      const child = path.join(projectPath, entry);
      try {
        if (!fs.statSync(child).isDirectory()) continue;
        const childPkg = this.loadPackageJson(child);
        if (!('error' in childPkg) && this.findTestScript(childPkg) !== undefined) {
          return { dir: child };
        }
      } catch {
        // 忽略损坏的符号链接 / 无权限目录
      }
    }
    return { error: '未找到含 test 脚本的项目目录' };
  }

  /** 从项目目录的 package.json 探测测试命令 */
  detectTestCommand(
    projectPath: string,
  ): { testCmd: string; testArgs: string[] } | { error: string } {
    const pkg = this.loadPackageJson(projectPath);
    if ('error' in pkg) return pkg as { error: string };

    const testScript = this.findTestScript(pkg);
    if (!testScript) {
      return { error: 'No test script found in package.json' };
    }

    return this.toTestCommand(testScript);
  }

  /** 将测试脚本拆分为命令与参数 */
  toTestCommand(testScript: string): { testCmd: string; testArgs: string[] } {
    const parts = testScript.split(WHITESPACE);
    const bin = parts[0];
    const args = parts.slice(1);

    // turbo 默认只输出任务摘要（缓存任务不重放子进程日志），vitest 计数不可见，
    // 解析器读到 0 个测试会误报「未发现测试用例」；--output-logs=full 强制重放子进程输出
    if (bin === 'turbo') {
      return {
        testCmd: 'npx',
        testArgs: ['turbo', ...args, '--output-logs=full'],
      };
    }

    // If using pnpm, run the raw runner directly
    // 脚本形如 "vitest run" 时过滤掉重复的 run，避免 vitest 将其当作测试名过滤器
    return {
      testCmd: bin === 'vitest' ? 'npx' : bin,
      testArgs: bin === 'vitest' ? ['vitest', 'run', ...args.filter((a) => a !== 'run')] : args,
    };
  }

  /** 读取并解析 package.json */
  private loadPackageJson(projectPath: string): Record<string, unknown> | { error: string } {
    const pkgJsonPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      return { error: 'package.json not found' };
    }

    try {
      return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    } catch {
      return { error: 'Invalid package.json' };
    }
  }

  /** 从 package.json scripts 中查找测试脚本 */
  private findTestScript(pkg: Record<string, unknown>): string | undefined {
    const scripts = pkg.scripts as Record<string, string | undefined> | undefined;
    return scripts?.test || scripts?.['test:run'] || scripts?.vitest;
  }
}
