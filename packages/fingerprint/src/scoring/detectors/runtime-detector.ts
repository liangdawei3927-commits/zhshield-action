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
  return (
    detectElectronRuntime(scan, framework) ??
    detectBrowserRuntime(scan, framework) ??
    detectBunRuntime(scan) ??
    detectNodeRuntime(language) ??
    detectMappedRuntime(language)
  );
}

function detectElectronRuntime(
  scan: ScanResult,
  framework: ProjectFramework,
): ProfileSignal[] | null {
  if (
    framework === 'electron' ||
    hasFile(scan, 'electron/main.ts') ||
    hasFile(scan, 'electron/main.js')
  ) {
    return [
      {
        file: '(framework-inferred)',
        kind: 'source-pattern',
        matched: 'framework=electron',
        inferred: { runtime: 'electron' },
      },
    ];
  }
  return null;
}

function detectBrowserRuntime(
  scan: ScanResult,
  framework: ProjectFramework,
): ProfileSignal[] | null {
  if (BROWSER_FRAMEWORKS.includes(framework) && !hasFile(scan, 'package.json')) {
    return [
      {
        file: '(framework-inferred)',
        kind: 'source-pattern',
        matched: `framework=${framework}`,
        inferred: { runtime: 'browser' },
      },
    ];
  }
  if (BROWSER_FRAMEWORKS.includes(framework) && !['next', 'nuxt'].includes(framework)) {
    return [
      {
        file: '(framework-inferred)',
        kind: 'source-pattern',
        matched: `framework=${framework}`,
        inferred: { runtime: 'browser' },
      },
    ];
  }
  return null;
}

function detectBunRuntime(scan: ScanResult): ProfileSignal[] | null {
  if (hasFile(scan, 'bun.lockb')) {
    return [
      {
        file: 'bun.lockb',
        kind: 'config-file',
        matched: 'bun.lockb',
        inferred: { runtime: 'bun' },
      },
    ];
  }
  return null;
}

function detectNodeRuntime(language: ProjectLanguage): ProfileSignal[] | null {
  if (language === 'typescript' || language === 'javascript') {
    return [
      {
        file: '(language-inferred)',
        kind: 'source-pattern',
        matched: `language=${language}`,
        inferred: { runtime: 'node' },
      },
    ];
  }
  return null;
}

function detectMappedRuntime(language: ProjectLanguage): ProfileSignal[] {
  const mapped = LANG_RUNTIME[language];
  if (mapped) {
    return [
      {
        file: '(language-inferred)',
        kind: 'source-pattern',
        matched: `language=${language}`,
        inferred: { runtime: mapped },
      },
    ];
  }
  return [];
}
