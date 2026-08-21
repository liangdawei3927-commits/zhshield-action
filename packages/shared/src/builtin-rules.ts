import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import type { BuiltinRule, IssueCategory, IssueSeverity } from './types';

/**
 * Level 3 降级内置规则（~50 条）
 *
 * 当所有外部工具都失败时使用这些基础规则进行兜底扫描。
 * 规则覆盖三个维度：安全、质量、架构。
 */

/** 内置规则定义：message 改为 messageKey（i18n 目录键），emit 时按语言翻译 */
interface FallbackRuleDef {
  ruleId: string;
  severity: IssueSeverity;
  category: IssueCategory;
  messageKey: string;
  pattern?: string;
}

const FALLBACK_RULE_DEFS: FallbackRuleDef[] = [
  // ─── 安全规则 (20) ────────────────────────────────────
  {
    ruleId: 'fallback/security/hardcoded-password',
    severity: 'error',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.hardcodedPassword',
    pattern: 'password\\s*[=:]\\s*["\'](?!\\$|process\\.env|import\\.meta)',
  },
  {
    ruleId: 'fallback/security/hardcoded-api-key',
    severity: 'error',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.hardcodedApiKey',
    pattern: '(api[_-]?key|apikey|secret|token)\\s*[=:]\\s*["\'][A-Za-z0-9_\\-]{16,}',
  },
  {
    ruleId: 'fallback/security/sql-concat',
    severity: 'error',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.sqlConcat',
    pattern: '(SELECT|INSERT|UPDATE|DELETE).*\\+\\s*(req\\.|body\\.|params\\.|query\\.)',
  },
  {
    ruleId: 'fallback/security/eval-usage',
    severity: 'error',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.evalUsage',
    pattern: '\\beval\\s*\\(',
  },
  {
    ruleId: 'fallback/security/innerhtml',
    severity: 'warning',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.innerHtml',
    pattern: '\\.innerHTML\\s*=',
  },
  {
    ruleId: 'fallback/security/no-rate-limit',
    severity: 'warning',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.noRateLimit',
    pattern: 'app\\.(get|post|put|delete|patch)\\(',
  },
  {
    ruleId: 'fallback/security/insecure-random',
    severity: 'warning',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.insecureRandom',
    pattern: 'Math\\.random\\(',
  },
  {
    ruleId: 'fallback/security/command-injection',
    severity: 'error',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.commandInjection',
    pattern: '(exec|spawn|execSync|spawnSync)\\s*\\(\\s*["\']',
  },
  {
    ruleId: 'fallback/security/prototype-pollution',
    severity: 'error',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.prototypePollution',
    pattern: '__proto__|constructor\\.prototype',
  },
  {
    ruleId: 'fallback/security/debug-endpoint',
    severity: 'warning',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.debugEndpoint',
    pattern: '(/debug|/__webpack|/sockjs-node)',
  },
  {
    ruleId: 'fallback/security/no-cors',
    severity: 'info',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.noCors',
    pattern: 'cors\\(',
  },
  {
    ruleId: 'fallback/security/no-helmet',
    severity: 'info',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.noHelmet',
    pattern: 'helmet\\(',
  },
  {
    ruleId: 'fallback/security/path-traversal',
    severity: 'error',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.pathTraversal',
    pattern: 'readFile(Sync)?\\(.*\\+\\s*(req|params|body)',
  },
  {
    ruleId: 'fallback/security/no-tls',
    severity: 'warning',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.noTls',
    pattern: 'http\\.createServer',
  },
  {
    ruleId: 'fallback/security/insecure-deserialize',
    severity: 'error',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.insecureDeserialize',
    pattern: 'JSON\\.parse|unserialize|pickle\\.loads',
  },
  {
    ruleId: 'fallback/security/no-csp',
    severity: 'info',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.noCsp',
    pattern: 'Content-Security-Policy',
  },
  {
    ruleId: 'fallback/security/console-log-secret',
    severity: 'warning',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.consoleLogSecret',
    pattern: 'console\\.(log|dir|info)\\s*\\(\\s*(password|secret|token|key)',
  },
  {
    ruleId: 'fallback/security/no-auth',
    severity: 'error',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.noAuth',
    pattern: 'app\\.(post|put|delete|patch)\\(["\']/',
  },
  {
    ruleId: 'fallback/security/sensitive-files',
    severity: 'warning',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.sensitiveFiles',
    pattern: '(\\.env|\\.pem|\\.key|credentials\\.json|config\\.yml)',
  },
  {
    ruleId: 'fallback/security/no-https-redirect',
    severity: 'warning',
    category: 'security',
    messageKey: 'engine.builtin-rules.security.noHttpsRedirect',
    pattern: 'https\\:',
  },

  // ─── 质量规则 (18) ─────────────────────────────────────
  {
    ruleId: 'fallback/quality/console-log',
    severity: 'warning',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.consoleLog',
    pattern: 'console\\.(log|debug|trace)\\(',
  },
  {
    ruleId: 'fallback/quality/debugger',
    severity: 'error',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.debugger',
    pattern: '\\bdebugger\\b',
  },
  {
    ruleId: 'fallback/quality/todo-comment',
    severity: 'info',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.todoComment',
    pattern: '\\bTODO\\b|\\bFIXME\\b|\\bHACK\\b|\\bXXX\\b',
  },
  {
    ruleId: 'fallback/quality/empty-catch',
    severity: 'warning',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.emptyCatch',
    pattern: 'catch\\s*\\([^)]*\\)\\s*\\{\\s*\\}',
  },
  {
    ruleId: 'fallback/quality/duplicate-key',
    severity: 'error',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.duplicateKey',
    pattern: '(\\w+):\\s*[^,]+,\\s*\\1:',
  },
  {
    ruleId: 'fallback/quality/missing-fallthrough',
    severity: 'warning',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.missingFallthrough',
    pattern: 'case\\s+[^:]+:\\s*\\n(?!\\s*break)',
  },
  {
    ruleId: 'fallback/quality/var-usage',
    severity: 'warning',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.varUsage',
    pattern: '\\bvar\\s+',
  },
  {
    ruleId: 'fallback/quality/eqeqeq',
    severity: 'warning',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.eqeqeq',
    pattern: '==\\s[^=]|==\\n',
  },
  {
    ruleId: 'fallback/quality/no-null-comparison',
    severity: 'info',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.noNullComparison',
    pattern: '===\\s*null|!==\\s*null',
  },
  {
    ruleId: 'fallback/quality/async-without-await',
    severity: 'warning',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.asyncWithoutAwait',
    pattern: 'async\\s+function\\s+\\w+\\s*\\([^)]*\\)\\s*\\{\\s*(?!await)',
  },
  {
    ruleId: 'fallback/quality/for-in-without-hasown',
    severity: 'warning',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.forInWithoutHasOwn',
    pattern: 'for\\s*\\(\\s*(var|let|const)\\s+\\w+\\s+in\\s+',
  },
  {
    ruleId: 'fallback/quality/no-barrel-import',
    severity: 'info',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.noBarrelImport',
    pattern: "from\\s+['\"]\\.\\.?/[^'\"]*/index['\"]",
  },
  {
    ruleId: 'fallback/quality/large-function',
    severity: 'info',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.largeFunction',
    pattern: '',
  },
  {
    ruleId: 'fallback/quality/complex-condition',
    severity: 'info',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.complexCondition',
    pattern: '&&.*\\|\\|.*&&\\|\\|.*\\|\\|.*&&',
  },
  {
    ruleId: 'fallback/quality/nested-callback',
    severity: 'info',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.nestedCallback',
    pattern: '',
  },
  {
    ruleId: 'fallback/quality/magic-number',
    severity: 'info',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.magicNumber',
    pattern: '',
  },
  {
    ruleId: 'fallback/quality/type-any',
    severity: 'warning',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.typeAny',
    pattern: ':\\s*any\\b',
  },
  {
    ruleId: 'fallback/quality/no-unused-variable',
    severity: 'warning',
    category: 'quality',
    messageKey: 'engine.builtin-rules.quality.noUnusedVariable',
    pattern: '',
  },

  // ─── 架构规则 (12) ─────────────────────────────────────
  {
    ruleId: 'fallback/architecture/circular-dependency',
    severity: 'error',
    category: 'architecture',
    messageKey: 'engine.builtin-rules.architecture.circularDependency',
    pattern: '',
  },
  {
    ruleId: 'fallback/architecture/layer-violation',
    severity: 'error',
    category: 'architecture',
    messageKey: 'engine.builtin-rules.architecture.layerViolation',
    pattern: '',
  },
  {
    ruleId: 'fallback/architecture/no-entity-in-controller',
    severity: 'warning',
    category: 'architecture',
    messageKey: 'engine.builtin-rules.architecture.noEntityInController',
    pattern: '',
  },
  {
    ruleId: 'fallback/architecture/no-domain-in-infra',
    severity: 'warning',
    category: 'architecture',
    messageKey: 'engine.builtin-rules.architecture.noDomainInInfra',
    pattern: '',
  },
  {
    ruleId: 'fallback/architecture/cyclic-import',
    severity: 'error',
    category: 'architecture',
    messageKey: 'engine.builtin-rules.architecture.cyclicImport',
    pattern: '',
  },
  {
    ruleId: 'fallback/architecture/utils-everywhere',
    severity: 'info',
    category: 'architecture',
    messageKey: 'engine.builtin-rules.architecture.utilsEverywhere',
    pattern: '',
  },
  {
    ruleId: 'fallback/architecture/no-service-in-view',
    severity: 'warning',
    category: 'architecture',
    messageKey: 'engine.builtin-rules.architecture.noServiceInView',
    pattern: '',
  },
  {
    ruleId: 'fallback/architecture/global-state',
    severity: 'warning',
    category: 'architecture',
    messageKey: 'engine.builtin-rules.architecture.globalState',
    pattern: '',
  },
  {
    ruleId: 'fallback/architecture/missing-abstraction',
    severity: 'info',
    category: 'architecture',
    messageKey: 'engine.builtin-rules.architecture.missingAbstraction',
    pattern: '',
  },
  {
    ruleId: 'fallback/architecture/layer-skip',
    severity: 'warning',
    category: 'architecture',
    messageKey: 'engine.builtin-rules.architecture.layerSkip',
    pattern: '',
  },
  {
    ruleId: 'fallback/architecture/fat-controller',
    severity: 'info',
    category: 'architecture',
    messageKey: 'engine.builtin-rules.architecture.fatController',
    pattern: '',
  },
  {
    ruleId: 'fallback/architecture/no-dto-in-entity',
    severity: 'warning',
    category: 'architecture',
    messageKey: 'engine.builtin-rules.architecture.noDtoInEntity',
    pattern: '',
  },
];

/**
 * 按语言构建兜底规则数组。
 * message 字段在构建时翻译为本地化字符串（载荷字段名与结构不变）。
 */
export function buildFallbackRules(locale?: LanguageCode): BuiltinRule[] {
  return FALLBACK_RULE_DEFS.map(({ messageKey, ...def }) => ({
    ...def,
    message: translate(messageKey, locale ?? DEFAULT_LANGUAGE),
  }));
}

/** 默认语言（zh-Hans）的兜底规则，保证既有调用方行为不变 */
export const BUILTIN_FALLBACK_RULES: BuiltinRule[] = buildFallbackRules();
