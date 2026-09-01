// 内联语言/清单/配置/扩展名/形态信号规则表（无外部运行时依赖，新语言/新形态 = 加一条规则）。
// 框架关键词表见 framework-map.ts（按语言分文件，保持单文件 ≤250 纯 LOC）。

import type { LanguageId, ProductFormId } from './types';

/** 扩展名（不含点）→ 语言。用于 ext-stat 统计与内容采样。 */
export const EXTENSION_LANGUAGES: Readonly<Record<string, LanguageId>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  java: 'java',
  go: 'go',
  rs: 'rust',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  dart: 'dart',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
};

/** 参与扩展名统计的语言集合（决定 ext-stat 信号枚举范围）。 */
export const STAT_LANGUAGES: readonly LanguageId[] = [
  'typescript',
  'javascript',
  'python',
  'java',
  'go',
  'rust',
  'csharp',
  'php',
  'ruby',
  'kotlin',
  'swift',
  'dart',
  'c',
  'cpp',
  'shell',
];

/** 清单文件规则：命中即产出 'manifest:<slug>' 语言信号。 */
export interface ManifestRule {
  readonly ruleId: string;
  readonly language: LanguageId;
  /** 命中判定：相对文件名 */
  readonly match: (name: string) => boolean;
}

export const MANIFEST_RULES: readonly ManifestRule[] = [
  { ruleId: 'manifest:package-json', language: 'javascript', match: (n) => n === 'package.json' },
  { ruleId: 'manifest:pyproject', language: 'python', match: (n) => n === 'pyproject.toml' },
  {
    ruleId: 'manifest:requirements-txt',
    language: 'python',
    match: (n) => n === 'requirements.txt',
  },
  { ruleId: 'manifest:setup-py', language: 'python', match: (n) => n === 'setup.py' },
  { ruleId: 'manifest:pipfile', language: 'python', match: (n) => n === 'Pipfile' },
  { ruleId: 'manifest:pom-xml', language: 'java', match: (n) => n === 'pom.xml' },
  { ruleId: 'manifest:go-mod', language: 'go', match: (n) => n === 'go.mod' },
  { ruleId: 'manifest:cargo-toml', language: 'rust', match: (n) => n === 'Cargo.toml' },
  { ruleId: 'manifest:composer-json', language: 'php', match: (n) => n === 'composer.json' },
  { ruleId: 'manifest:gemfile', language: 'ruby', match: (n) => n === 'Gemfile' },
  { ruleId: 'manifest:csproj', language: 'csharp', match: (n) => n.endsWith('.csproj') },
];

/** lockfile 文件名 → 包管理器。manifest-detector 据此产出 'manifest:package-manager:<m>'。 */
export const LOCKFILE_MANAGERS: Readonly<Record<string, string>> = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'package-lock.json': 'npm',
  'bun.lockb': 'bun',
  'poetry.lock': 'poetry',
  'uv.lock': 'uv',
  'Pipfile.lock': 'pipenv',
};

/** 配置文件规则（config-detector）：框架/语言/环境信号。 */
export interface ConfigRule {
  readonly ruleId: string;
  readonly confidence: number;
  /** 命中判定：相对文件名 */
  readonly match: (name: string) => boolean;
  readonly framework?: string;
  readonly environment?: string;
  readonly language?: LanguageId;
}

const TSCONFIG_RE = /^tsconfig(\.\w+)?\.json$/;

export const CONFIG_RULES: readonly ConfigRule[] = [
  {
    ruleId: 'config:tsconfig',
    confidence: 0.95,
    language: 'typescript',
    match: (n) => TSCONFIG_RE.test(n),
  },
  {
    ruleId: 'config:vue-config',
    confidence: 0.9,
    framework: 'Vue',
    match: (n) => n === 'vue.config.js' || n === 'vue.config.ts',
  },
  {
    ruleId: 'config:vite',
    confidence: 0.9,
    framework: 'Vite',
    match: (n) => n.startsWith('vite.config.'),
  },
  {
    ruleId: 'config:next-config',
    confidence: 0.9,
    framework: 'Next.js',
    match: (n) => n.startsWith('next.config.'),
  },
  {
    ruleId: 'config:nuxt-config',
    confidence: 0.9,
    framework: 'Nuxt',
    match: (n) => n.startsWith('nuxt.config.'),
  },
  {
    ruleId: 'config:svelte-config',
    confidence: 0.9,
    framework: 'Svelte',
    match: (n) => n.startsWith('svelte.config.'),
  },
  {
    ruleId: 'config:angular',
    confidence: 0.9,
    framework: 'Angular',
    match: (n) => n === 'angular.json',
  },
  {
    ruleId: 'config:nest-cli',
    confidence: 0.9,
    framework: 'NestJS',
    match: (n) => n === 'nest-cli.json',
  },
  {
    ruleId: 'config:node-version',
    confidence: 1,
    environment: 'node',
    match: (n) => n === '.nvmrc' || n === '.node-version',
  },
  {
    ruleId: 'config:python-version',
    confidence: 1,
    environment: 'python',
    match: (n) => n === '.python-version',
  },
  {
    ruleId: 'config:docker',
    confidence: 1,
    environment: 'docker',
    match: (n) =>
      n === 'Dockerfile' ||
      n === 'docker-compose.yml' ||
      n === 'docker-compose.yaml' ||
      n === 'compose.yaml' ||
      n === 'compose.yml',
  },
  {
    ruleId: 'config:ci',
    confidence: 1,
    environment: 'ci',
    match: (n) => n.startsWith('.github/workflows/'),
  },
];

/** 环境信号规则 ID → 环境名（用于 content/其它聚合）。 */
export const ENVIRONMENT_NAMES: Readonly<Record<string, string>> = {
  'config:node-version': 'node',
  'config:python-version': 'python',
  'config:docker': 'docker',
  'config:ci': 'ci',
};

/** 形态特征文件的原始信号规则（form-detector 文件存在性判定，只出原始信号不做语义判定）。 */
export interface FormFileRule {
  readonly ruleId: string;
  readonly productForm: ProductFormId;
  /** 命中判定：相对文件名 */
  readonly match: (name: string) => boolean;
}

export const FORM_FILE_RULES: readonly FormFileRule[] = [
  { ruleId: 'form:tauri', productForm: 'pc', match: (n) => n === 'tauri.conf.json' },
  { ruleId: 'form:podfile', productForm: 'ios', match: (n) => n === 'Podfile' },
  {
    ruleId: 'form:xcodeproj',
    productForm: 'ios',
    match: (n) => n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace'),
  },
  {
    ruleId: 'form:android-gradle',
    productForm: 'android',
    match: (n) => n === 'build.gradle' || n === 'build.gradle.kts' || n === 'settings.gradle',
  },
  {
    ruleId: 'form:android-manifest',
    productForm: 'android',
    match: (n) => n === 'AndroidManifest.xml',
  },
  {
    ruleId: 'form:miniapp-project-config',
    productForm: 'miniapp',
    match: (n) => n === 'project.config.json',
  },
  { ruleId: 'form:index-html', productForm: 'h5', match: (n) => n === 'index.html' },
  {
    ruleId: 'form:web-bundler',
    productForm: 'h5',
    match: (n) => n.startsWith('vite.config.') || n.startsWith('webpack.config.'),
  },
];

/** 目录约定形态信号（中文生态目录命名，只出候选）。 */
export const FORM_DIR_RULES: Readonly<Record<string, ProductFormId>> = {
  admin: 'admin',
  web: 'h5',
  app: 'mobile',
  miniapp: 'miniapp',
  api: 'backend',
  ios: 'ios',
  android: 'android',
};

/** slug 化：'Spring Boot' → 'spring-boot'，'@nestjs/core' → 'nestjs-core'。 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[@/\\.]/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
