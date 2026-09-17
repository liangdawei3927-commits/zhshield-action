/**
 * rule-def-config.ts — SOP 规则 ruleDef → dependency-cruiser 配置合成
 *
 * 自 DependencyCruiserAdapter 抽出（zhcheck large-class 治理）。
 *
 * 背景（09-17 定案）：规则 YAML 里声明的 check.rules[].ruleDef 从未被使用 ——
 * 适配器恒以 --config 指向项目本地 / 内核默认配置，架构规范的检查内容实际由
 * 配置文件决定，规则文件形同装饰（circular-dependency 声明 4 条，实际只跑 1 条）。
 * 本模块负责在规则声明了 ruleDef 时合成临时配置，使规则成为检查内容的来源。
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * dep-cruiser 基线 options —— 与内核默认资产
 * assets/dependency-cruiser/.dependency-cruiser.cjs 保持一致；
 * 仅在基线配置缺失/加载失败时兜底，避免合成配置丢掉 TS 解析能力。
 */
export const DEFAULT_OPTIONS = {
  doNotFollow: { path: 'node_modules' },
  tsPreCompilationDeps: true,
  tsConfig: { fileName: './tsconfig.json' },
  exclude: { path: '^node_modules' },
};

/**
 * 从 SOP 规则的 check.rules 提取 dep-cruiser 规则定义。
 *
 * 条目形如 `{ id, description, severity, ruleDef: { from, to } }`；
 * severity 由 SOP 口径（error / warning）映射为 dep-cruiser 口径（error / warn），
 * 其余字段直接透传（from / to / comment 等）。
 */
export function extractRuleDefs(rules: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rules)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const raw of rules) {
    if (typeof raw !== 'object' || raw === null) continue;
    const rule = raw as Record<string, unknown>;
    const ruleDef = rule.ruleDef;
    if (typeof ruleDef !== 'object' || ruleDef === null) continue;
    out.push({
      name: String(rule.id ?? 'sop-rule'),
      ...(typeof rule.description === 'string' ? { comment: rule.description } : {}),
      severity: rule.severity === 'warning' ? 'warn' : 'error',
      ...(ruleDef as Record<string, unknown>),
    });
  }
  return out;
}

/**
 * 加载已解析的 dep-cruiser 配置模块，用作合成配置的 options 基线。
 * cjs/js 走 require（锚定本模块目录，不依赖 cwd），json 走解析；失败返回 null。
 */
function loadConfigModule(configPath: string | null): Record<string, unknown> | null {
  if (!configPath) return null;
  try {
    if (configPath.endsWith('.json')) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    }
    const require = createRequire(path.join(__dirname, 'package.json'));
    const mod = require(configPath) as Record<string, unknown> & { default?: unknown };
    const value = mod.default ?? mod;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 把规则声明合成为 dependency-cruiser 配置并写入临时文件。
 *
 * forbidden 段整体以规则为准；options 段从基线配置继承，保持 exclude / tsConfig
 * 等行为一致。
 *
 * @returns 临时配置文件绝对路径；规则未声明 ruleDef 时返回 null（沿用基线配置）
 */
export async function writeRuleDefConfigFile(
  rules: unknown,
  baseConfigPath: string | null,
): Promise<string | null> {
  const forbidden = extractRuleDefs(rules);
  if (forbidden.length === 0) return null;

  const base = loadConfigModule(baseConfigPath);
  const merged = {
    ...base,
    options: (base?.options as Record<string, unknown> | undefined) ?? DEFAULT_OPTIONS,
    forbidden,
  };
  const file = path.join(os.tmpdir(), `zhshield-depcruise-${randomUUID()}.cjs`);
  await fs.promises.writeFile(
    file,
    `// 由智汇码盾 SOP 规则生成（临时文件，扫描结束后自动清理）\n` +
      `module.exports = ${JSON.stringify(merged, null, 2)};\n`,
    'utf-8',
  );
  return file;
}

/** 删除合成配置临时文件（失败静默：受限目录下的残留无害，不得影响扫描结论） */
export async function removeFileQuietly(file: string): Promise<void> {
  try {
    await fs.promises.rm(file, { force: true });
  } catch {
    // 忽略清理失败
  }
}
