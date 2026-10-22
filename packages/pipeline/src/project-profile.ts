import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  normalizePackageName,
  extractPyprojectDeps,
  extractRequirementsNames,
  type ProjectLanguage,
  type PackageManager,
  type ProjectProfile,
} from '@zh/shared';

// 项目画像类型统一由 @zh/shared 定义（跨包单一事实源）；此处重新导出以保持
// @zh/pipeline 既有公开 API（index.ts 的 export type 与下游消费不变）。
export type { ProjectLanguage, PackageManager, ProjectProfile };

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

/** 嵌套仓库下探时跳过的噪声目录（语义对齐 kernel scan-utils 的 NOISE_DIRS） */
const NESTED_PROBE_NOISE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'release',
  '.turbo',
  '.cache',
]);

/**
 * 解析有效项目根（容器目录下探）。
 *
 * 扫描目标无 package.json 且非 Python 项目时，若一层子目录中恰好存在唯一
 * 含合法 package.json 的嵌套仓库根（如容器目录 → zhihui-codeshield/），
 * 则返回该子目录；其余情况（本身是项目根 / 无候选 / 多候选）原样返回，
 * 不擅自猜测。供 PipelineRunner 与 desktop 画像探测在链路早期统一调用，
 * 使画像识别（→ toolScope 裁剪）与各工具适配器（→ depcheck 等 package.json
 * 前置校验）看到同一个真实项目根。
 */
export function resolveEffectiveProjectRoot(projectPath: string): string {
  const root = path.resolve(projectPath);
  if (fs.existsSync(path.join(root, 'package.json'))) return root;
  if (hasPythonManifest(root)) return root;

  const candidates = listNestedProjectRootCandidates(root);
  return candidates.length === 1 ? candidates[0] : root;
}

/** 列出一层子目录中含合法 package.json 的候选项目根（跳过点开头与噪声目录） */
function listNestedProjectRootCandidates(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // 目录不可读：无候选，调用方回退原目标
    return [];
  }

  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || NESTED_PROBE_NOISE_DIRS.has(entry.name)) continue;
    const pkgPath = path.join(root, entry.name, 'package.json');
    try {
      JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    } catch {
      // 无 package.json 或清单损坏：不作为候选
      continue;
    }
    candidates.push(path.join(root, entry.name));
  }
  return candidates;
}
