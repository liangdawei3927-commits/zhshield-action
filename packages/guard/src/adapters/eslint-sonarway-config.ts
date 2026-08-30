// 智汇码盾内置 SonarWay 规则集（guard.block.eslint.sonarway）
//
// 来源：SonarSource 的 eslint-plugin-sonarjs（SonarWay for JS/TS 的官方 ESLint 形态）
// 选型：只挑选"高价值 bug 检测"类规则（S 系 rule-category == "Bug" 的高置信度子集），
//       不启用纯风格/复杂度/命名类规则，保证免费层输出聚焦真实缺陷、信噪比高。
//
// 用法：本 config 供 GuardSonarwayESLintAdapter 通过 ESLint Node API 加载，
//       不依赖被检项目的 eslint 安装与配置。
import sonarjs from 'eslint-plugin-sonarjs';
import { parser as tsParser } from 'typescript-eslint';

/** SonarWay 高价值 bug 检测规则（sonarjs/bug 类），按严重度分组 */
const SONARWAY_BUG_RULES: Record<string, 'error' | 'warn'> = {
  // 逻辑错误 / 恒真恒假 / 死代码
  'sonarjs/no-duplicated-branches': 'error',
  'sonarjs/no-identical-conditions': 'error',
  'sonarjs/no-inverted-boolean-check': 'error',
  'sonarjs/no-identical-expressions': 'error',
  'sonarjs/no-collection-size-mischeck': 'error',
  'sonarjs/no-ignored-return': 'warn',
  'sonarjs/no-dead-store': 'warn',
  'sonarjs/no-useless-increment': 'warn',
  'sonarjs/prefer-immediate-return': 'warn',
  // 空指针 / 未定义 / 误用
  'sonarjs/null-dereference': 'error',
  'sonarjs/no-undefined-assignment': 'error',
  'sonarjs/no-extra-arguments': 'warn',
  // 循环与控制流隐患
  'sonarjs/misplaced-loop-counter': 'error',
  'sonarjs/for-loop-increment-sign': 'error',
  'sonarjs/no-nested-switch': 'warn',
  'sonarjs/no-nested-functions': 'warn',
  'sonarjs/no-globals-shadowing': 'warn',
  // 安全 / 敏感项
  'sonarjs/code-eval': 'error',
  'sonarjs/no-hardcoded-passwords': 'warn',
  'sonarjs/sql-queries': 'error',
};

/**
 * 内置 SonarWay flat config。
 * 覆盖 JS/TS/TSX；TS/TSX 用 typescript-eslint parser 解析以满足 sonarjs 的类型相关规则。
 */
export function buildSonarwayConfig(): unknown[] {
  return [
    {
      name: 'zhcodeshield/guard/sonarway-plugin',
      plugins: { sonarjs },
      rules: { ...SONARWAY_BUG_RULES },
    },
    {
      name: 'zhcodeshield/guard/sonarway-ts',
      files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
      languageOptions: {
        parser: tsParser,
        parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      },
    },
  ];
}
