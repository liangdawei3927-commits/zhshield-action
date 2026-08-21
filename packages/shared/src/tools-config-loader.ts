import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolConfig, ToolsConfig, GuardConfig } from './types';

const INDENT_PATTERN = /\S/;
const NUMERIC_KEY = /^\d+$/;

interface RawToolsYaml {
  tools?: Record<string, Record<string, unknown>>;
}

interface RawGuardYaml {
  guard?: {
    'pre-commit'?: { enabled?: boolean; checks?: string[]; timeout?: number };
    'pre-push'?: { enabled?: boolean; checks?: string[]; timeout?: number };
    ci?: { enabled?: boolean; checks?: string[]; timeout?: number };
  };
}

export class ToolsConfigLoader {
  private projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  private findConfigFile(...names: string[]): string | null {
    for (const name of names) {
      const p = path.join(this.projectPath, '.zhshield', name);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  loadToolsConfig(): ToolsConfig | null {
    const filePath = this.findConfigFile('tools.yml', 'tools.yaml');
    if (!filePath) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = this.parseSimpleYaml(content) as RawToolsYaml;

      if (!parsed.tools) return null;

      return { tools: this.buildToolsConfig(parsed.tools) };
    } catch {
      return null;
    }
  }

  /** 从解析后的 tools 段构建全量工具配置 */
  private buildToolsConfig(tools: RawToolsYaml['tools']): ToolsConfig['tools'] {
    return {
      eslint: this.parseToolConfig(tools!.eslint || {}),
      semgrep: this.parseToolConfig(tools!.semgrep || {}),
      trivy: this.parseToolConfig(tools!.trivy || {}),
      gitleaks: this.parseToolConfig(tools!.gitleaks || {}),
      grype: this.parseToolConfig(tools!.grype || {}),
      ort: this.parseToolConfig(tools!.ort || {}),
      depcheck: this.parseToolConfig(tools!.depcheck || {}),
      'dependency-cruiser': this.parseToolConfig(tools!['dependency-cruiser'] || {}),
      'ts-prune': this.parseToolConfig(tools!['ts-prune'] || {}),
    };
  }

  loadGuardConfig(): GuardConfig | null {
    const filePath = this.findConfigFile('guard.yml', 'guard.yaml');
    if (!filePath) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = this.parseSimpleYaml(content) as RawGuardYaml;

      if (!parsed.guard) return null;

      return this.buildGuardConfig(parsed.guard);
    } catch {
      return null;
    }
  }

  /** 从解析后的 guard 段构建门禁配置（带默认值） */
  private buildGuardConfig(g: NonNullable<RawGuardYaml['guard']>): GuardConfig {
    return {
      guard: {
        'pre-commit': {
          enabled: g['pre-commit']?.enabled ?? true,
          checks: g['pre-commit']?.checks || ['eslint', 'gitleaks'],
          timeout: g['pre-commit']?.timeout || 5000,
        },
        'pre-push': {
          enabled: g['pre-push']?.enabled ?? true,
          checks: g['pre-push']?.checks || ['eslint', 'semgrep-high-severity', 'trivy'],
          timeout: g['pre-push']?.timeout || 30000,
        },
        ci: {
          enabled: g.ci?.enabled ?? true,
          checks: g.ci?.checks || ['all-pre-push', 'dependency-cruiser', 'ort'],
          timeout: g.ci?.timeout || 120000,
        },
      },
    };
  }

  private parseToolConfig(raw: Record<string, unknown>): ToolConfig {
    return {
      enabled: (raw.enabled as boolean) ?? true,
      config: raw.config as string | undefined,
      ignore: raw.ignore as string[] | undefined,
      severity: raw.severity as string[] | undefined,
      scanners: raw.scanners as string[] | undefined,
      rules: raw.rules as string[] | undefined,
      packageManagers: raw.packageManagers as string[] | undefined,
      timeout: raw.timeout as number | undefined,
    };
  }

  private parseSimpleYaml(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const stack: { indent: number; key: string; obj: Record<string, unknown> }[] = [];

    for (const line of content.split('\n')) {
      this.parseYamlLine(line, result, stack);
    }

    return this.cleanArrays(result);
  }

  /** 解析单行 YAML 并维护容器栈 */
  private parseYamlLine(
    line: string,
    result: Record<string, unknown>,
    stack: { indent: number; key: string; obj: Record<string, unknown> }[],
  ): void {
    if (!line.trim() || line.trim().startsWith('#')) return;

    const indent = line.search(INDENT_PATTERN);
    const trimmed = line.trim();

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) return;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    while (stack.length > 0 && stack.at(-1)!.indent >= indent) {
      stack.pop();
    }

    const currentObj = stack.length > 0 ? stack.at(-1)!.obj : result;

    if (value === '' || value === '|' || value === '>') {
      this.pushContainer(stack, currentObj, key, indent);
    } else if (key.startsWith('- ')) {
      this.pushArrayItem(currentObj, key, value);
    } else {
      currentObj[key] = this.parseScalar(value);
    }
  }

  private pushContainer(
    stack: { indent: number; key: string; obj: Record<string, unknown> }[],
    parent: Record<string, unknown>,
    key: string,
    indent: number,
  ): Record<string, unknown> {
    const newObj: Record<string, unknown> = {};
    if (key.startsWith('- ')) {
      const arr = (parent._array || (parent._array = [])) as unknown[];
      const item: Record<string, unknown> = {};
      arr.push(item);
      stack.push({ indent, key, obj: item });
      return item;
    }
    parent[key] = newObj;
    stack.push({ indent, key, obj: newObj });
    return newObj;
  }

  private pushArrayItem(currentObj: Record<string, unknown>, key: string, value: string): void {
    const cleanKey = key.slice(2);
    let arr = currentObj[cleanKey] as unknown[];
    if (!Array.isArray(arr)) {
      arr = [];
      currentObj[cleanKey] = arr;
    }
    arr.push(this.parseScalar(value));
  }

  private parseScalar(value: string): unknown {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    const num = Number(value);
    if (!isNaN(num) && value.trim() !== '') return num;
    return value.replace(/^['"]|['"]$/g, '');
  }

  private cleanArrays(obj: Record<string, unknown>): Record<string, unknown> {
    if (obj._array) {
      const arr = obj._array as Record<string, unknown>[];
      delete obj._array;
      for (const item of arr) {
        this.cleanArrays(item);
      }
      return arr as unknown as Record<string, unknown>;
    }

    const keys = Object.keys(obj);
    if (keys.length === 1 && NUMERIC_KEY.test(keys[0])) {
      return obj;
    }

    for (const key of keys) {
      this.cleanValue(obj[key]);
    }
    return obj;
  }

  private cleanValue(val: unknown): void {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      this.cleanArrays(val as Record<string, unknown>);
      return;
    }
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object') {
          this.cleanArrays(item as Record<string, unknown>);
        }
      }
    }
  }
}
