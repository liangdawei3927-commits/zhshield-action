import type { ProfileSignal, ProjectFramework, ProjectLanguage, Runtime } from '../types';
import type { ScanResult } from '../file-scanner';
import { hasFile } from '../file-scanner';

/**
 * 运行时探测器 — 由语言 + 框架 + 锁文件综合推断。
 *
 * 规则：
 * - framework=electron → electron（覆盖语言推断）
 * - 纯前端框架无 electron → browser
 * - typescript/javascript → node（默认）/ bun（有 bun.lockb）
 * - 其他语言 → 对应运行时
 */
const LANG_RUNTIME: Partial<Record<ProjectLanguage, Runtime>> = {
  go: 'go',
  python: 'python',
  rust: 'rust',
  java: 'jvm',
  kotlin: 'jvm',
  csharp: 'dotnet',
};

const BROWSER_FRAMEWORKS: ProjectFramework[] = ['react', 'vue', 'next', 'nuxt', 'svelte'];

export function detectRuntime(
  scan: ScanResult,
  language: ProjectLanguage,
  framework: ProjectFramework,
): ProfileSignal[] {
  const signals: ProfileSignal[] = [];

  // electron 优先（覆盖 node/browser）
  if (framework === 'electron' || hasFile(scan, 'electron/main.ts') || hasFile(scan, 'electron/main.js')) {
    signals.push({
      file: '(framework-inferred)',
      kind: 'source-pattern',
      matched: 'framework=electron',
      inferred: { runtime: 'electron' },
    });
    return signals;
  }

  // 纯前端框架 → browser
  if (BROWSER_FRAMEWORKS.includes(framework) && !hasFile(scan, 'package.json')) {
    signals.push({
      file: '(framework-inferred)',
      kind: 'source-pattern',
      matched: `framework=${framework}`,
      inferred: { runtime: 'browser' },
    });
    return signals;
  }
  // 有 package.json 但纯前端框架 + 无 node 后端特征 → 仍可能是 browser
  if (BROWSER_FRAMEWORKS.includes(framework) && !['next', 'nuxt'].includes(framework)) {
    signals.push({
      file: '(framework-inferred)',
      kind: 'source-pattern',
      matched: `framework=${framework}`,
      inferred: { runtime: 'browser' },
    });
    return signals;
  }

  // bun 锁文件
  if (hasFile(scan, 'bun.lockb')) {
    signals.push({
      file: 'bun.lockb',
      kind: 'config-file',
      matched: 'bun.lockb',
      inferred: { runtime: 'bun' },
    });
    return signals;
  }

  // typescript/javascript 默认 node
  if (language === 'typescript' || language === 'javascript') {
    signals.push({
      file: '(language-inferred)',
      kind: 'source-pattern',
      matched: `language=${language}`,
      inferred: { runtime: 'node' },
    });
    return signals;
  }

  // 其他语言映射
  const mapped = LANG_RUNTIME[language];
  if (mapped) {
    signals.push({
      file: '(language-inferred)',
      kind: 'source-pattern',
      matched: `language=${language}`,
      inferred: { runtime: mapped },
    });
  }

  return signals;
}
