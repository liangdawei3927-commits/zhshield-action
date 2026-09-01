import type { ProfileSignal, ProjectFramework } from '../types';
import type { ScanResult } from '../file-scanner';
import { hasFile, readConfig } from '../file-scanner';

/**
 * 框架探测器 — 依据依赖声明与配置文件特征判定框架。
 *
 * 策略：
 * - Node 生态：解析 package.json 的 dependencies/devDependencies
 * - 其他语言：读 go.mod / requirements.txt / Cargo.toml / pom.xml 的依赖名
 * - 框架特征文件：electron 的 main 指向 electron、小程序的 project.config.json
 */
interface DepMatch {
  pattern: string | RegExp;
  framework: ProjectFramework;
}

const NODE_DEPS: DepMatch[] = [
  { pattern: '@nestjs/core', framework: 'nestjs' },
  { pattern: '@nestjs/common', framework: 'nestjs' },
  { pattern: 'express', framework: 'express' },
  { pattern: 'fastify', framework: 'fastify' },
  { pattern: 'koa', framework: 'koa' },
  { pattern: 'next', framework: 'next' },
  { pattern: 'nuxt', framework: 'nuxt' },
  { pattern: 'react', framework: 'react' },
  { pattern: 'vue', framework: 'vue' },
  { pattern: 'svelte', framework: 'svelte' },
  { pattern: 'electron', framework: 'electron' },
  { pattern: 'react-native', framework: 'react-native' },
  { pattern: '@tarojs/taro', framework: 'taro' },
  { pattern: '@dcloudio/uni-app', framework: 'uni-app' },
];

const GO_DEPS: DepMatch[] = [
  { pattern: 'gin-gonic/gin', framework: 'gin' },
  { pattern: 'labstack/echo', framework: 'none' },
];

const PY_DEPS: DepMatch[] = [
  { pattern: 'django', framework: 'django' },
  { pattern: 'flask', framework: 'flask' },
  { pattern: 'fastapi', framework: 'fastapi' },
];

const RUST_DEPS: DepMatch[] = [{ pattern: 'actix-web', framework: 'actix' }];

const JVM_DEPS: DepMatch[] = [
  { pattern: 'spring-boot', framework: 'spring' },
  { pattern: 'spring-boot-starter', framework: 'spring' },
];

function matchDeps(depText: string, matches: DepMatch[]): ProjectFramework | null {
  for (const m of matches) {
    if (typeof m.pattern === 'string') {
      if (depText.includes(m.pattern)) return m.framework;
    } else if (m.pattern.test(depText)) {
      return m.framework;
    }
  }
  return null;
}

function depMatched(m: DepMatch): string {
  return typeof m.pattern === 'string' ? m.pattern : m.pattern.source;
}

const ELECTRON_MAIN_RE = /electron|main\.js|background/;

/** 从 package.json 提取所有依赖名拼接成文本 */
function extractNodeDeps(pkgJson: string): string {
  try {
    const pkg = JSON.parse(pkgJson);
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return Object.keys(deps).join(' ');
  } catch {
    return '';
  }
}

export function detectFramework(scan: ScanResult): ProfileSignal[] {
  const signals: ProfileSignal[] = [];

  // --- Node 生态 ---
  pushNodeFrameworkSignals(scan, signals);
  // --- 小程序特征文件 ---
  pushWeappSignal(scan, signals);
  // --- 其他语言依赖（Go / Python / Rust / JVM）---
  pushGoFrameworkSignal(scan, signals);
  pushPythonFrameworkSignal(scan, signals);
  pushRustFrameworkSignal(scan, signals);
  pushJvmFrameworkSignal(scan, signals);

  return signals;
}

function pushNodeFrameworkSignals(scan: ScanResult, signals: ProfileSignal[]): void {
  const pkgContent = readConfig(scan, 'package.json');
  if (pkgContent) {
    const depText = extractNodeDeps(pkgContent);
    for (const m of NODE_DEPS) {
      if (typeof m.pattern === 'string' && depText.includes(m.pattern)) {
        signals.push({
          file: 'package.json',
          kind: 'dependency',
          matched: m.pattern,
          inferred: { framework: m.framework },
        });
      }
    }

    // electron 的 main 字段指向 electron 入口
    try {
      const pkg = JSON.parse(pkgContent);
      if (pkg.main && ELECTRON_MAIN_RE.test(String(pkg.main)) && depText.includes('electron')) {
        // 已由 dep 命中，不重复
      }
    } catch {
      // ignore
    }
  }
}

function pushWeappSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  if (hasFile(scan, 'project.config.json')) {
    signals.push({
      file: 'project.config.json',
      kind: 'config-file',
      matched: 'project.config.json',
      inferred: { framework: 'weapp', type: 'mini-program' },
    });
  }
}

function pushGoFrameworkSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  const goMod = readConfig(scan, 'go.mod');
  if (goMod) {
    const fw = matchDeps(goMod, GO_DEPS);
    if (fw) {
      signals.push({
        file: 'go.mod',
        kind: 'dependency',
        matched: depMatched(GO_DEPS.find((m) => m.framework === fw)!),
        inferred: { framework: fw },
      });
    }
  }
}

function pushPythonFrameworkSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  const pyConfig = readConfig(scan, 'requirements.txt') ?? readConfig(scan, 'pyproject.toml');
  if (pyConfig) {
    const pyFile = hasFile(scan, 'requirements.txt') ? 'requirements.txt' : 'pyproject.toml';
    const fw = matchDeps(pyConfig, PY_DEPS);
    if (fw) {
      signals.push({
        file: pyFile,
        kind: 'dependency',
        matched: depMatched(PY_DEPS.find((m) => m.framework === fw)!),
        inferred: { framework: fw },
      });
    }
  }
}

function pushRustFrameworkSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  const cargo = readConfig(scan, 'Cargo.toml');
  if (cargo) {
    const fw = matchDeps(cargo, RUST_DEPS);
    if (fw) {
      signals.push({
        file: 'Cargo.toml',
        kind: 'dependency',
        matched: 'actix-web',
        inferred: { framework: fw },
      });
    }
  }
}

function pushJvmFrameworkSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  const pom = readConfig(scan, 'pom.xml');
  if (pom) {
    const fw = matchDeps(pom, JVM_DEPS);
    if (fw) {
      signals.push({
        file: 'pom.xml',
        kind: 'dependency',
        matched: 'spring-boot',
        inferred: { framework: fw },
      });
    }
  }
}
