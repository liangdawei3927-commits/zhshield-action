import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizePackageName, extractPyprojectDeps, extractRequirementsNames } from '@zh/shared';

/** 项目语言（JS/TS 走 package.json 判定，Python 走清单信号判定） */
export type ProjectLanguage = 'typescript' | 'javascript' | 'python' | 'unknown';

/** 包管理器（JS 侧按锁文件判定，Python 侧按 poetry/uv/Pipfile 等锁定文件判定） */
export type PackageManager =
  'npm' | 'pnpm' | 'yarn' | 'pip' | 'poetry' | 'uv' | 'pipenv' | 'unknown';

/** 项目画像：语言、框架、包管理器与是否含 TypeScript（供流水线选择应启用的域） */
export interface ProjectProfile {
  projectPath: string;
  language: ProjectLanguage;
  framework: string | null;
  packageManager: PackageManager;
  hasTypeScript: boolean;
}

const FRAMEWORK_KEYWORDS: Array<{ name: string; keywords: string[] }> = [
  { name: 'NestJS', keywords: ['@nestjs/core', '@nestjs/common'] },
  { name: 'React', keywords: ['react', 'react-dom', '@reduxjs/toolkit'] },
  { name: 'Vue', keywords: ['vue', '@vue/cli-service'] },
  { name: 'Next.js', keywords: ['next'] },
  { name: 'Express', keywords: ['express'] },
  { name: 'Fastify', keywords: ['fastify'] },
  { name: 'Electron', keywords: ['electron'] },
  { name: 'Koa', keywords: ['koa'] },
  { name: 'Svelte', keywords: ['svelte', '@sveltejs/kit'] },
  { name: 'Angular', keywords: ['@angular/core'] },
];

const PYTHON_FRAMEWORK_KEYWORDS: Array<{ name: string; keywords: string[] }> = [
  { name: 'Django', keywords: ['django'] },
  { name: 'FastAPI', keywords: ['fastapi'] },
  { name: 'Flask', keywords: ['flask'] },
  { name: 'Tornado', keywords: ['tornado'] },
];

const PYTHON_MANIFESTS = [
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'Pipfile',
  'Pipfile.lock',
  'poetry.lock',
  'uv.lock',
] as const;

function detectPythonFramework(projectPath: string): string | null {
  const names = new Set<string>();
  const pyprojectPath = path.join(projectPath, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    for (const raw of extractPyprojectDeps(fs.readFileSync(pyprojectPath, 'utf-8'))) {
      const name = normalizePackageName(raw);
      if (name) names.add(name);
    }
  }
  const requirementsPath = path.join(projectPath, 'requirements.txt');
  if (fs.existsSync(requirementsPath)) {
    for (const raw of extractRequirementsNames(fs.readFileSync(requirementsPath, 'utf-8'))) {
      const name = normalizePackageName(raw);
      if (name) names.add(name);
    }
  }
  for (const candidate of PYTHON_FRAMEWORK_KEYWORDS) {
    if (candidate.keywords.some((keyword) => names.has(normalizePackageName(keyword)))) {
      return candidate.name;
    }
  }
  return null;
}

function detectLanguage(pkg: Record<string, unknown>, hasTsConfig: boolean): ProjectLanguage {
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  if (
    hasTsConfig ||
    typeof deps?.typescript === 'string' ||
    typeof deps?.['ts-node'] === 'string'
  ) {
    return 'typescript';
  }
  if (deps && Object.keys(deps).length > 0) return 'javascript';
  return 'unknown';
}

function detectFramework(pkg: Record<string, unknown>): string | null {
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  if (!deps) return null;
  for (const candidate of FRAMEWORK_KEYWORDS) {
    if (candidate.keywords.some((k) => deps[k])) return candidate.name;
  }
  return null;
}

function detectPackageManager(projectPath: string): PackageManager {
  for (const [lockFile, manager] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
    ['bun.lockb', 'unknown'],
  ] as const) {
    if (fs.existsSync(path.join(projectPath, lockFile))) return manager;
  }
  return 'unknown';
}

function hasPythonManifest(projectPath: string): boolean {
  return PYTHON_MANIFESTS.some((manifest) => fs.existsSync(path.join(projectPath, manifest)));
}

function detectPythonPackageManager(projectPath: string): PackageManager {
  for (const [file, manager] of [
    ['poetry.lock', 'poetry'],
    ['uv.lock', 'uv'],
    ['Pipfile', 'pipenv'],
    ['Pipfile.lock', 'pipenv'],
  ] as const) {
    if (fs.existsSync(path.join(projectPath, file))) return manager;
  }
  if (
    fs.existsSync(path.join(projectPath, 'requirements.txt')) ||
    fs.existsSync(path.join(projectPath, 'pyproject.toml'))
  ) {
    return 'pip';
  }
  return 'unknown';
}

/**
 * 识别项目类型：package.json 优先（JS/TS）；无 package.json 时按 Python 清单信号识别。
 */
export function detectProjectProfile(projectPath: string): ProjectProfile {
  const pkgPath = path.join(projectPath, 'package.json');
  const hasTsConfig = fs.existsSync(path.join(projectPath, 'tsconfig.json'));
  const pkg = readPackageJson(pkgPath);
  const isPython = !fs.existsSync(pkgPath) && hasPythonManifest(projectPath);

  return {
    projectPath,
    language: isPython ? 'python' : detectLanguage(pkg, hasTsConfig),
    framework: isPython ? detectPythonFramework(projectPath) : detectFramework(pkg),
    packageManager: isPython
      ? detectPythonPackageManager(projectPath)
      : detectPackageManager(projectPath),
    hasTypeScript: !isPython && (hasTsConfig || detectLanguage(pkg, hasTsConfig) === 'typescript'),
  };
}

/** 读取并解析 package.json，无文件或解析失败时返回空对象 */
function readPackageJson(pkgPath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // 无 package.json 或解析失败：按未知语言处理
    return {};
  }
}
