import type { ProfileSignal, ProjectLanguage } from '../types';
import type { ScanResult } from '../file-scanner';
import { hasFile, countByExtension } from '../file-scanner';

/**
 * 语言探测器 — 依据配置文件存在性 + 源文件扩展名统计判定主语言。
 *
 * 判定优先级：
 * 1. 明确的语言配置文件（tsconfig.json / go.mod / Cargo.toml ...）→ 高置信
 * 2. 扩展名文件数统计 → 中置信
 * 3. 兜底 unknown
 */
export function detectLanguage(scan: ScanResult): ProfileSignal[] {
  const signals: ProfileSignal[] = [];

  // --- 明确配置文件特征 ---
  pushTsConfigSignal(scan, signals);
  pushGoModSignal(scan, signals);
  pushCargoSignal(scan, signals);
  pushPythonSignal(scan, signals);
  pushJavaSignal(scan, signals);
  pushGradleSignal(scan, signals);
  pushPhpSignal(scan, signals);
  pushRubySignal(scan, signals);
  pushCsprojSignal(scan, signals);
  pushPackageJsonSignal(scan, signals);
  // --- 扩展名统计作为佐证 ---
  pushExtensionSignals(scan, signals);
  // --- Solidity 特殊：无标准配置文件，靠扩展名 ---
  pushSoliditySignal(scan, signals);

  return signals;
}

function pushTsConfigSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  if (hasFile(scan, 'tsconfig.json')) {
    signals.push({
      file: 'tsconfig.json',
      kind: 'config-file',
      matched: 'tsconfig.json',
      inferred: { language: 'typescript', runtime: 'node' },
    });
  }
}

function pushGoModSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  if (hasFile(scan, 'go.mod')) {
    signals.push({
      file: 'go.mod',
      kind: 'config-file',
      matched: 'go.mod',
      inferred: { language: 'go', runtime: 'go', packageManager: 'go-mod' },
    });
  }
}

function pushCargoSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  if (hasFile(scan, 'Cargo.toml')) {
    signals.push({
      file: 'Cargo.toml',
      kind: 'config-file',
      matched: 'Cargo.toml',
      inferred: { language: 'rust', runtime: 'rust', packageManager: 'cargo' },
    });
  }
}

function pushPythonSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  for (const pyFile of ['pyproject.toml', 'requirements.txt', 'setup.py']) {
    if (hasFile(scan, pyFile)) {
      signals.push({
        file: pyFile,
        kind: 'config-file',
        matched: pyFile,
        inferred: { language: 'python', runtime: 'python' },
      });
      break;
    }
  }
}

function pushJavaSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  if (hasFile(scan, 'pom.xml')) {
    signals.push({
      file: 'pom.xml',
      kind: 'config-file',
      matched: 'pom.xml',
      inferred: { language: 'java', runtime: 'jvm', packageManager: 'maven' },
    });
  }
}

function pushGradleSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  if (hasFile(scan, 'build.gradle') || hasFile(scan, 'build.gradle.kts')) {
    const f = hasFile(scan, 'build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle';
    signals.push({
      file: f,
      kind: 'config-file',
      matched: f,
      inferred: { language: hasFile(scan, 'src/main/kotlin') ? 'kotlin' : 'java', runtime: 'jvm', packageManager: 'gradle' },
    });
  }
}

function pushPhpSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  if (hasFile(scan, 'composer.json')) {
    signals.push({
      file: 'composer.json',
      kind: 'config-file',
      matched: 'composer.json',
      inferred: { language: 'php', packageManager: 'composer' },
    });
  }
}

function pushRubySignal(scan: ScanResult, signals: ProfileSignal[]): void {
  if (hasFile(scan, 'Gemfile')) {
    signals.push({
      file: 'Gemfile',
      kind: 'config-file',
      matched: 'Gemfile',
      inferred: { language: 'ruby' },
    });
  }
}

function pushCsprojSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  const csprojFile = scan.files.find((f) => f.endsWith('.csproj'));
  if (csprojFile) {
    signals.push({
      file: csprojFile,
      kind: 'config-file',
      matched: '*.csproj',
      inferred: { language: 'csharp', runtime: 'dotnet' },
    });
  }
}

function pushPackageJsonSignal(scan: ScanResult, signals: ProfileSignal[]): void {
  if (hasFile(scan, 'package.json')) {
    const hasTsConfig = signals.some((s) => s.matched === 'tsconfig.json');
    const tsCount = countByExtension(scan, ['ts', 'tsx']);
    const jsCount = countByExtension(scan, ['js', 'jsx', 'mjs', 'cjs']);
    if (hasTsConfig || tsCount > jsCount) {
      signals.push({
        file: 'package.json',
        kind: 'config-file',
        matched: 'package.json (ts-dominant)',
        inferred: { language: 'typescript', packageManager: 'npm', runtime: 'node' },
      });
    } else {
      signals.push({
        file: 'package.json',
        kind: 'config-file',
        matched: 'package.json (js-dominant)',
        inferred: { language: 'javascript', packageManager: 'npm', runtime: 'node' },
      });
    }
  }
}

function pushExtensionSignals(scan: ScanResult, signals: ProfileSignal[]): void {
  const extSignals: Array<{ exts: string[]; lang: ProjectLanguage }> = [
    { exts: ['ts', 'tsx'], lang: 'typescript' },
    { exts: ['go'], lang: 'go' },
    { exts: ['py'], lang: 'python' },
    { exts: ['rs'], lang: 'rust' },
    { exts: ['java'], lang: 'java' },
    { exts: ['kt', 'kts'], lang: 'kotlin' },
    { exts: ['cs'], lang: 'csharp' },
    { exts: ['php'], lang: 'php' },
    { exts: ['rb'], lang: 'ruby' },
    { exts: ['sol'], lang: 'solidity' },
  ];
  for (const { exts, lang } of extSignals) {
    const c = countByExtension(scan, exts);
    if (c > 0) {
      signals.push({
        file: `*.{${exts.join(',')}}`,
        kind: 'source-pattern',
        matched: `${c} files`,
        inferred: { language: lang },
      });
    }
  }
}

function pushSoliditySignal(scan: ScanResult, signals: ProfileSignal[]): void {
  if (!signals.some((s) => s.inferred.language === 'solidity')) {
    const solCount = countByExtension(scan, ['sol']);
    if (solCount > 0 && !signals.some((s) => s.inferred.language)) {
      signals.push({
        file: '*.sol',
        kind: 'source-pattern',
        matched: `${solCount} files`,
        inferred: { language: 'solidity' },
      });
    }
  }
}