// form-detector（权重 0.5）：只采集"形态特征文件存在性"原始信号（架构文档 C10），
// 不做任何语义判定——形态语义判定在 Profiler 第二阶段（消费语言结果 + 交叉验证）。

import type { Detector } from '../detector';
import type { Signal, SignalKind } from '../types';
import { FORM_FILE_RULES } from '../language-map';
import { SERVER_FRAMEWORK_DEP_KEYWORDS } from '../framework-map';
import { walkFiles, readText, findDirsMatching } from '../fs-utils';
import { makeSignal, readManifestDepNames, conventionDirSignals } from './types';

const KIND: SignalKind = 'form';

const SERVER_PREFIX_RULES: readonly string[] = [
  '@nestjs/',
  'spring-boot-starter',
  'spring-cloud-starter',
  'dubbo-',
];

const DB_CONFIG_FILES: ReadonlySet<string> = new Set([
  '.env',
  'application.yml',
  'application.yaml',
  'application.properties',
]);

function isServerFrameworkDep(name: string): boolean {
  if (SERVER_FRAMEWORK_DEP_KEYWORDS.has(name)) return true;
  return SERVER_PREFIX_RULES.some((prefix) => name.startsWith(prefix));
}

function hasDbConfigMarker(content: string): boolean {
  if (/DATABASE_URL|DB_HOST|DB_NAME|DB_USER|DB_PASSWORD|POSTGRES_|MYSQL_|MONGO_|REDIS_/.test(content)) return true;
  return /\b(datasource|jdbc:|mongodb:|postgres:|mysql:|redis:)/i.test(content);
}

/** .xcodeproj/.xcworkspace 是 macOS bundle 目录，作为叶子整体收集（不下钻内部），复用 fs-utils 共享递归遍历。 */
function findXcodeBundles(projectRoot: string): string[] {
  return findDirsMatching(projectRoot, (name) => name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace'));
}

/**
 * 形态特征原始信号（§6.2 形态识别信号表）：
 * package.json 含 electron / tauri.conf.json→pc；ios/+Podfile/*.xcodeproj→ios；
 * android/+build.gradle/AndroidManifest.xml→android；project.config.json→miniapp；
 * index.html+vite.config/webpack.config→h5；服务端框架+db 配置+api/ 目录→backend。
 */
export class FormDetector implements Detector {
  readonly id = 'form-detector';
  readonly signalKinds = [KIND] as const;
  readonly weight = 0.5;

  async detect(projectPath: string): Promise<Signal[]> {
    const signals: Signal[] = [];
    for (const bundle of findXcodeBundles(projectPath)) {
      signals.push(makeSignal(KIND, 'form:xcodeproj', bundle, this.weight, { productForm: 'ios' }));
    }
    for (const rel of walkFiles(projectPath)) {
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      for (const rule of FORM_FILE_RULES) {
        if (rule.match(name)) {
          signals.push(makeSignal(KIND, rule.ruleId, rel, this.weight, { productForm: rule.productForm }));
        }
      }
      if (DB_CONFIG_FILES.has(name)) {
        let content: string;
        try {
          content = readText(projectPath, rel);
        } catch {
          continue;
        }
        if (hasDbConfigMarker(content)) signals.push(makeSignal(KIND, 'form:db-config', rel, this.weight, {}));
      }
      const deps = readManifestDepNames(projectPath, rel, name);
      if (deps.size === 0) continue;
      if (deps.has('electron')) signals.push(makeSignal(KIND, 'form:electron', rel, this.weight, { dependency: 'electron', productForm: 'pc' }));
      if (deps.has('react-native')) signals.push(makeSignal(KIND, 'form:react-native', rel, this.weight, { dependency: 'react-native', productForm: 'mobile' }));
      if (deps.has('@tarojs/cli') || deps.has('@tarojs/taro') || deps.has('taro')) {
        signals.push(makeSignal(KIND, 'form:taro', rel, this.weight, { dependency: 'taro', productForm: 'miniapp' }));
      }
      if ([...deps].some((n) => isServerFrameworkDep(n))) {
        signals.push(makeSignal(KIND, 'form:server-framework', rel, this.weight, { productForm: 'backend' }));
      }
    }
    signals.push(...conventionDirSignals(projectPath, this.weight));
    return signals.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : a.file < b.file ? -1 : 1));
  }
}
