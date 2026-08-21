import * as fs from 'node:fs';
import * as path from 'node:path';

interface HookScript {
  hook: string;
  content: string;
}

const HOOKS: HookScript[] = [
  {
    hook: 'pre-commit',
    content: `#!/bin/sh
# 智汇码盾 pre-commit hook
# 检查暂存区文件的代码质量和密钥泄露

ZHSHIELD_BIN=$(which zhshield 2>/dev/null || echo "")
if [ -z "$ZHSHIELD_BIN" ]; then
  ZHSHIELD_BIN=$(npx zhshield 2>/dev/null || echo "")
fi

if [ -n "$ZHSHIELD_BIN" ]; then
  zhshield guard --hook=pre-commit
  EXIT_CODE=$?
  if [ $EXIT_CODE -ne 0 ]; then
    echo "❌ 智汇码盾门禁检查未通过，请修复后重新提交"
    exit 1
  fi
fi
`,
  },
  {
    hook: 'pre-push',
    content: `#!/bin/sh
# 智汇码盾 pre-push hook
# 全量检查代码质量、安全漏洞和依赖安全

ZHSHIELD_BIN=$(which zhshield 2>/dev/null || echo "")
if [ -z "$ZHSHIELD_BIN" ]; then
  ZHSHIELD_BIN=$(npx zhshield 2>/dev/null || echo "")
fi

if [ -n "$ZHSHIELD_BIN" ]; then
  zhshield guard --hook=pre-push
  EXIT_CODE=$?
  if [ $EXIT_CODE -ne 0 ]; then
    echo "❌ 智汇码盾门禁检查未通过，请修复后重新推送"
    exit 1
  fi
fi
`,
  },
  {
    hook: 'post-commit',
    content: `#!/bin/sh
# 智汇码盾 post-commit hook
# 记录提交审计信息
exit 0
`,
  },
];

export class HooksInstaller {
  private projectPath: string;
  private hooksDir: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.hooksDir = path.join(projectPath, '.git', 'hooks');
  }

  async install(hookName?: string): Promise<string[]> {
    const installed: string[] = [];
    const targets = hookName
      ? HOOKS.filter((h) => h.hook === hookName)
      : HOOKS;

    await fs.promises.mkdir(this.hooksDir, { recursive: true });

    for (const hook of targets) {
      const hookPath = path.join(this.hooksDir, hook.hook);
      await fs.promises.writeFile(hookPath, hook.content, { mode: 0o755 });
      installed.push(hook.hook);
    }

    return installed;
  }

  async uninstall(hookName?: string): Promise<string[]> {
    const removed: string[] = [];
    const targets = hookName
      ? HOOKS.filter((h) => h.hook === hookName)
      : HOOKS;

    for (const hook of targets) {
      const hookPath = path.join(this.hooksDir, hook.hook);
      try {
        await fs.promises.unlink(hookPath);
        removed.push(hook.hook);
      } catch {
        // hook may not exist
      }
    }

    return removed;
  }

  async isInstalled(hookName?: string): Promise<boolean> {
    const targets = hookName
      ? HOOKS.filter((h) => h.hook === hookName)
      : HOOKS;

    for (const hook of targets) {
      const hookPath = path.join(this.hooksDir, hook.hook);
      try {
        await fs.promises.access(hookPath, fs.constants.X_OK);
      } catch {
        return false;
      }
    }
    return true;
  }

  hasGitDir(): boolean {
    return fs.existsSync(path.join(this.projectPath, '.git'));
  }

  listInstalledHooks(): string[] {
    if (!fs.existsSync(this.hooksDir)) return [];
    try {
      return fs.readdirSync(this.hooksDir).filter((f) =>
        HOOKS.some((h) => h.hook === f)
      );
    } catch {
      return [];
    }
  }
}
