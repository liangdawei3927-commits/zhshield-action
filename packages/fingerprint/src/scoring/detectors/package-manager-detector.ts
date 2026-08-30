import type { ProfileSignal } from '../types';
import type { ScanResult } from '../file-scanner';
import { hasFile, readConfig } from '../file-scanner';

const POETRY_SECTION_RE = /\[tool\.poetry\]/;

/**
 * 包管理器探测器 — 锁文件优先于配置文件。
 *
 * 锁文件是包管理器的铁证；配置文件（package.json/go.mod）是次级证据，
 * 因为它们只声明依赖清单，不证明用哪个工具安装。
 */
export function detectPackageManager(scan: ScanResult): ProfileSignal[] {
  const signals: ProfileSignal[] = [];

  // --- 锁文件铁证（优先级最高）---
  if (pushLockFileSignal(scan, signals)) {
    return signals; // 锁文件唯一确定，直接返回
  }
  // --- 配置文件次级证据 ---
  pushGoModSignal(scan, signals);
  pushPythonPackageManagerSignal(scan, signals);
  pushCargoSignal(scan, signals);
  pushMavenOrGradleSignal(scan, signals);
  pushComposerSignal(scan, signals);
  // package.json 无锁文件时默认 npm（最低置信）
  pushDefaultNpmSignal(scan, signals);

  return signals;
}

function pushLockFileSignal(scan: ScanResult, signals: ProfileSignal[]): boolean {
  const lockFiles: Array<[string, ProfileSignal['inferred']['packageManager']]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['go.sum', 'go-mod'],
    ['Cargo.lock', 'cargo'],
    ['poetry.lock', 'poetry'],
    ['composer.lock', 'composer'],
  ];
  for (const [file, pm] of lockFiles) {
    if (hasFile(scan, file)) {
      signals.push({
        file,
        kind: 'config-file',
        matched: file,
        inferred: { packageManager: pm! },
      });
      return true;
    }
  }
  return false;
}

function pushGoModSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  if (hasFile(scan, 'go.mod')) {
    signals.push({
      file: 'go.mod',
      kind: 'config-file',
      matched: 'go.mod',
      inferred: { packageManager: 'go-mod' },
    });
  }
}

function pushPythonPackageManagerSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  if (hasFile(scan, 'requirements.txt')) {
    signals.push({
      file: 'requirements.txt',
      kind: 'config-file',
      matched: 'requirements.txt',
      inferred: { packageManager: 'pip' },
    });
  } else if (hasFile(scan, 'pyproject.toml')) {
    const content = readConfig(scan, 'pyproject.toml');
    if (content && POETRY_SECTION_RE.test(content)) {
      signals.push({
        file: 'pyproject.toml',
        kind: 'config-file',
        matched: '[tool.poetry]',
        inferred: { packageManager: 'poetry' },
      });
    }
  }
}

function pushCargoSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  if (hasFile(scan, 'Cargo.toml')) {
    signals.push({
      file: 'Cargo.toml',
      kind: 'config-file',
      matched: 'Cargo.toml',
      inferred: { packageManager: 'cargo' },
    });
  }
}

function pushMavenOrGradleSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  if (hasFile(scan, 'pom.xml')) {
    signals.push({
      file: 'pom.xml',
      kind: 'config-file',
      matched: 'pom.xml',
      inferred: { packageManager: 'maven' },
    });
  } else if (hasFile(scan, 'build.gradle') || hasFile(scan, 'build.gradle.kts')) {
    signals.push({
      file: hasFile(scan, 'build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle',
      kind: 'config-file',
      matched: 'build.gradle*',
      inferred: { packageManager: 'gradle' },
    });
  }
}

function pushComposerSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  if (hasFile(scan, 'composer.json')) {
    signals.push({
      file: 'composer.json',
      kind: 'config-file',
      matched: 'composer.json',
      inferred: { packageManager: 'composer' },
    });
  }
}

function pushDefaultNpmSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  if (hasFile(scan, 'package.json') && signals.length === 0) {
    signals.push({
      file: 'package.json',
      kind: 'config-file',
      matched: 'package.json (no lockfile)',
      inferred: { packageManager: 'npm' },
    });
  }
}