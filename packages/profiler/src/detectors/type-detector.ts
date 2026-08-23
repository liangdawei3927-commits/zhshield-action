import type { ProfileSignal, ProjectType, ProjectFramework } from '../types';
import type { ScanResult } from '../file-scanner';
import { hasFile, readConfig } from '../file-scanner';

/**
 * 项目类型探测器 — 综合 monorepo 标志 + 框架 + package.json 元数据判定。
 *
 * 优先级：
 * 1. monorepo 标志文件 → monorepo
 * 2. 框架映射（framework → type）
 * 3. package.json bin 字段 → cli；private:false + exports → library
 * 4. 兜底 unknown
 */
const FRAMEWORK_TYPE_MAP: Record<ProjectFramework, ProjectType | undefined> = {
  nestjs: 'backend',
  express: 'backend',
  fastify: 'backend',
  koa: 'backend',
  gin: 'backend',
  spring: 'backend',
  django: 'backend',
  flask: 'backend',
  fastapi: 'backend',
  actix: 'backend',
  react: 'frontend',
  vue: 'frontend',
  next: 'frontend',
  nuxt: 'frontend',
  svelte: 'frontend',
  electron: 'desktop',
  'react-native': 'app',
  flutter: 'app',
  weapp: 'mini-program',
  taro: 'mini-program',
  'uni-app': 'mini-program',
  none: undefined,
  unknown: undefined,
};

export function detectProjectType(scan: ScanResult, framework: ProjectFramework): ProfileSignal[] {
  const signals: ProfileSignal[] = [];

  // --- monorepo 标志 ---
  const monorepoFiles = ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json'];
  for (const f of monorepoFiles) {
    if (hasFile(scan, f)) {
      signals.push({
        file: f,
        kind: 'config-file',
        matched: f,
        inferred: { type: 'monorepo' },
      });
      return signals; // monorepo 优先级最高，直接返回
    }
  }

  // --- 框架映射 ---
  const mappedType = FRAMEWORK_TYPE_MAP[framework];
  if (mappedType) {
    signals.push({
      file: '(framework-inferred)',
      kind: 'source-pattern',
      matched: `framework=${framework}`,
      inferred: { type: mappedType },
    });
  }

  // --- package.json bin / private ---
  const pkgContent = readConfig(scan, 'package.json');
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      // bin 字段 → cli
      if (pkg.bin && (typeof pkg.bin === 'string' || Object.keys(pkg.bin).length > 0)) {
        signals.push({
          file: 'package.json',
          kind: 'config-file',
          matched: 'bin',
          inferred: { type: 'cli' },
        });
      }
      // 非私有 + 有 exports → library（仅在没有框架映射时作为兜底）
      if (!mappedType && pkg.private === false && (pkg.exports || pkg.main)) {
        signals.push({
          file: 'package.json',
          kind: 'config-file',
          matched: 'private:false + exports',
          inferred: { type: 'library' },
        });
      }
    } catch {
      // ignore parse error
    }
  }

  return signals;
}
