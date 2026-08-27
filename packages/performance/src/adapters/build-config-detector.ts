/**
 * 构建配置检测器（build-config-detector.ts）
 *
 * 离线静态分析前端构建配置（vite / webpack / next / rollup）：
 * - 探测构建工具与配置文件（vite.config.* / webpack.config.* / next.config.* / rollup.config.*）
 * - 正则扫描关键优化项：minify / mode / sourcemap / chunkSizeWarningLimit
 * - 分析 package.json 构建脚本中的可疑标志（--no-minify / NODE_ENV=development / --sourcemap）
 *
 * 约束（对齐 P0-2「扫描中绝不执行项目代码」）：
 * - 零网络请求、零执行/转译，配置可能为 TS 文件，仅按文本正则匹配。
 * - 目录不存在 / 文件缺失 / 解析失败一律按「无此构建项」处理，绝不抛异常。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PerformanceConfig, PerformanceIssue, PerformanceSeverity } from '../types';

const VITE_MINIFY_RE = /minify\s*:\s*false\b/;
const VITE_SOURCEMAP_RE = /sourcemap\s*:\s*(?:true|'inline'|"inline")/;
const CHUNK_SIZE_LIMIT_RE = /chunkSizeWarningLimit\s*:\s*(\d+)/;
const WEBPACK_MODE_RE = /mode\s*:\s*['"]([^'"]+)['"]/;
const WEBPACK_MINIMIZE_RE = /minimize\s*:\s*false\b/;
const WEBPACK_DEVTOOL_RE = /devtool\s*:\s*['"](?:source-map|inline-source-map)['"]/;
const NODE_ENV_DEV_RE = /NODE_ENV\s*=\s*development/;

/** 构建配置检测器契约：离线静态检测，不联网不执行 */
export interface BuildConfigDetector {
  detect(projectRoot: string, config?: PerformanceConfig): PerformanceIssue[];
}

/** 前端构建工具 */
type BuildTool = 'vite' | 'webpack' | 'next' | 'rollup';

/** 构建配置文件候选（按优先级探测） */
const CONFIG_CANDIDATES: Array<{ tool: BuildTool; filename: string }> = [
  { tool: 'vite', filename: 'vite.config.ts' },
  { tool: 'vite', filename: 'vite.config.js' },
  { tool: 'vite', filename: 'vite.config.mts' },
  { tool: 'vite', filename: 'vite.config.mjs' },
  { tool: 'webpack', filename: 'webpack.config.ts' },
  { tool: 'webpack', filename: 'webpack.config.js' },
  { tool: 'webpack', filename: 'webpack.config.cjs' },
  { tool: 'webpack', filename: 'webpack.config.mjs' },
  { tool: 'next', filename: 'next.config.ts' },
  { tool: 'next', filename: 'next.config.js' },
  { tool: 'next', filename: 'next.config.mjs' },
  { tool: 'rollup', filename: 'rollup.config.ts' },
  { tool: 'rollup', filename: 'rollup.config.js' },
  { tool: 'rollup', filename: 'rollup.config.mjs' },
];

/** package.json 构建脚本中的构建工具标识（脚本名 → 工具） */
const BUILD_SCRIPT_MARKERS: Array<{ tool: BuildTool; marker: RegExp }> = [
  { tool: 'vite', marker: /vite\s+build/ },
  { tool: 'webpack', marker: /\bwebpack\b/ },
  { tool: 'next', marker: /next\s+build/ },
  { tool: 'rollup', marker: /\brollup\b/ },
];

/** 严重度权重（高 → 低，用于排序） */
const SEVERITY_ORDER: Record<PerformanceSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/** 安全读取文本文件；读取失败返回 null */
function readTextSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** 安全读取 package.json；解析失败返回 null */
function readPackageJson(projectRoot: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8');
    const data: unknown = JSON.parse(raw);
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** 构建配置检测器具体实现：离线静态正则扫描，绝不抛异常 */
export class BuildConfigDetectorImpl implements BuildConfigDetector {
  detect(projectRoot: string, _config?: PerformanceConfig): PerformanceIssue[] {
    // 每次调用重置 id 计数，保证同次检测内 id 稳定连续
    this.counter = 0;
    const issues: PerformanceIssue[] = [];

    // 1. 读取 package.json 的 build 脚本
    const pkg = readPackageJson(projectRoot);
    let buildScript = '';
    if (pkg !== null) {
      const scripts = pkg['scripts'];
      if (typeof scripts === 'object' && scripts !== null) {
        const scriptValue = (scripts as Record<string, unknown>)['build'];
        if (typeof scriptValue === 'string') {
          buildScript = scriptValue;
        }
      }
    }

    // 2. 探测配置文件（文件存在优先；无配置时回退到 package.json 构建脚本）
    let tool: BuildTool | null = null;
    let configFile = '';
    for (const candidate of CONFIG_CANDIDATES) {
      const filePath = path.join(projectRoot, candidate.filename);
      if (fs.existsSync(filePath)) {
        tool = candidate.tool;
        configFile = candidate.filename;
        break;
      }
    }

    // 3. 无配置文件 → 从构建脚本反推构建工具
    if (tool === null) {
      for (const marker of BUILD_SCRIPT_MARKERS) {
        if (marker.marker.test(buildScript)) {
          tool = marker.tool;
          break;
        }
      }
    }

    // 4. 既无构建配置也无构建脚本 → 未知项目类型，返回空（非错误）
    if (tool === null && buildScript === '') {
      return [];
    }

    // 5. 按工具扫描配置文本（TS 配置仅正则匹配，不执行不转译）
    if (tool !== null && configFile !== '') {
      const content = readTextSafe(path.join(projectRoot, configFile)) ?? '';
      this.scanConfig(issues, tool, configFile, content);
    }

    // 6. 扫描 package.json 构建脚本可疑标志
    if (buildScript !== '') {
      this.scanBuildScript(issues, buildScript);
    }

    // 7. 按严重度降序排列（high > medium > low > info），同级别按检出顺序
    return issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  }

  /** 按构建工具扫描配置文件 */
  private scanConfig(issues: PerformanceIssue[], tool: BuildTool, configFile: string, content: string): void {
    if (tool === 'vite') {
      this.scanViteConfig(issues, configFile, content);
    } else if (tool === 'webpack') {
      this.scanWebpackConfig(issues, configFile, content);
    }
  }

  /** vite 配置：minify 显式关闭 / sourcemap 开启 / chunkSizeWarningLimit 过大 */
  private scanViteConfig(issues: PerformanceIssue[], configFile: string, content: string): void {
    // minify 默认开启（esbuild），仅当显式关闭时告警
    if (VITE_MINIFY_RE.test(content)) {
      issues.push(this.makeIssue(
        'build-config.vite-minify-disabled',
        'high',
        configFile,
        `${configFile} 显式关闭了 minify，产物未压缩`,
        '移除 minify: false 或改为 true，让 Vite 默认以 esbuild 压缩产物',
      ));
    }
    // sourcemap：生产环境开启（true / 'inline'）建议关闭
    if (VITE_SOURCEMAP_RE.test(content)) {
      issues.push(this.makeIssue(
        'build-config.vite-sourcemap-enabled',
        'info',
        configFile,
        `${configFile} 开启了 sourcemap，产物体积增大且暴露源码`,
        '生产构建建议设置 build.sourcemap: false，仅在排障时按需开启',
      ));
    }
    // chunkSizeWarningLimit：阈值过高会掩盖大 chunk 告警
    const limitMatch = content.match(CHUNK_SIZE_LIMIT_RE);
    if (limitMatch) {
      const limitKb = Number(limitMatch[1]);
      if (limitKb > 1000) {
        issues.push(this.makeIssue(
          'build-config.vite-chunk-size-limit-high',
          'medium',
          configFile,
          `${configFile} 将 chunkSizeWarningLimit 设为 ${limitKb}kB，超过默认 500kB，大 chunk 告警被掩盖`,
          `建议将 chunkSizeWarningLimit 调回 500 或更低，暴露超限 chunk 以便拆分`,
        ));
      }
    }
  }

  /** webpack 配置：mode 未设 production / optimization.minimize 显式关闭 / devtool 泄漏源码 */
  private scanWebpackConfig(issues: PerformanceIssue[], configFile: string, content: string): void {
    // mode 缺失时 webpack 默认 development（不压缩）——未显式设置即视为高危
    const modeMatch = content.match(WEBPACK_MODE_RE);
    if (!modeMatch) {
      issues.push(this.makeIssue(
        'build-config.webpack-mode-missing',
        'high',
        configFile,
        `${configFile} 未设置 mode，webpack 默认 development 模式，产物不压缩`,
        `设置 mode: 'production' 以启用压缩与 tree-shaking`,
      ));
    } else if (modeMatch[1] !== 'production') {
      issues.push(this.makeIssue(
        'build-config.webpack-mode-not-production',
        'high',
        configFile,
        `${configFile} mode 为 '${modeMatch[1]}'，非 production，产物不压缩`,
        `将 mode 改为 'production'（或按环境注入 NODE_ENV=production）`,
      ));
    }
    // optimization.minimize 显式关闭
    if (WEBPACK_MINIMIZE_RE.test(content)) {
      issues.push(this.makeIssue(
        'build-config.webpack-minimize-disabled',
        'high',
        configFile,
        `${configFile} 显式关闭了 optimization.minimize，产物未压缩`,
        '移除 minimize: false 或改为 true，恢复默认压缩',
      ));
    }
    // devtool 完整 sourcemap 在产物中内嵌/外挂源码
    if (WEBPACK_DEVTOOL_RE.test(content)) {
      issues.push(this.makeIssue(
        'build-config.webpack-devtool-sourcemap',
        'info',
        configFile,
        `${configFile} 使用 ${'devtool'} sourcemap 模式，产物可还原源码`,
        '生产构建改用 hidden-source-map 或不配置 devtool',
      ));
    }
  }

  /** package.json build 脚本：可疑构建标志扫描 */
  private scanBuildScript(issues: PerformanceIssue[], script: string): void {
    if (script.includes('--no-minify') || script.includes('minify=false')) {
      issues.push(this.makeIssue(
        'build-config.script-minify-disabled',
        'high',
        'package.json',
        `package.json 的 build 脚本包含 ${script.includes('--no-minify') ? '--no-minify' : 'minify=false'}，构建产物未压缩`,
        '移除该标志，让构建工具以默认配置压缩产物',
      ));
    }
    if (NODE_ENV_DEV_RE.test(script)) {
      issues.push(this.makeIssue(
        'build-config.script-node-env-development',
        'high',
        'package.json',
        `package.json 的 build 脚本设置了 NODE_ENV=development，构建走开发分支，产物未做生产优化`,
        '将 NODE_ENV 改为 production（如 NODE_ENV=production npm run build）',
      ));
    }
    if (script.includes('--sourcemap')) {
      issues.push(this.makeIssue(
        'build-config.script-sourcemap',
        'info',
        'package.json',
        `package.json 的 build 脚本包含 --sourcemap，产物携带 sourcemap`,
        '生产构建移除 --sourcemap 标志，避免产物体积增大与源码暴露',
      ));
    }
  }

  /** 构造单条性能问题（id 稳定自增） */
  private makeIssue(ruleId: string, severity: PerformanceSeverity, file: string, message: string, suggestion: string): PerformanceIssue {
    return {
      id: `build-config-${this.nextId()}`,
      ruleId,
      category: 'build-config',
      severity,
      file,
      message,
      suggestion,
      autoFixable: false,
    };
  }

  private counter = 0;

  private nextId(): number {
    this.counter += 1;
    return this.counter;
  }
}

/** 便捷入口：同步语义的检测器单例 */
export const buildConfigDetector: BuildConfigDetector = new BuildConfigDetectorImpl();
