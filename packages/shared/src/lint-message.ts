/**
 * ESLint 输出中的单条消息（全仓唯一形状定义）。
 *
 * ## 为什么在 @zh/shared
 *
 * `eslint --format json` 与 ESLint Node API 产出的 messages 元素是同一个形状，
 * 此前在三个包各声明一份，反馈在 guard 包内部还多一份：
 *
 *   · `@zh/guard` `adapters/eslint-check-adapter.ts` 的 EslintMessage
 *   · `@zh/guard` `adapters/sonarway-eslint-adapter.ts` 的 LintMessage（多 `fatal`）
 *   · `@zh/inspect` `adapters/eslint-adapter.ts` 的 EslintOutputMessage（多 `fix`）
 *   · `@zh/pipeline` `sonarway-tool-adapter.ts` 的 LintMessage（多 `fatal`）
 *
 * 三处解析的是同一种外部输出。字段名一旦在一边被改动（例如 ESLint 版本升级后
 * `fatal` 换名），那一处会静默读不到值 —— 不报错，只是规则命中数悄悄变了。
 * 三个包都依赖 `@zh/shared`，故放在这里。
 *
 * `fatal` / `fix` 本来就是 ESLint 消息的字段，一并声明可避免上层再各扩一份
 * （此前 guard 与 pipeline 的 `fatal` 扩展、inspect 的 `fix` 扩展正是这样长出来的）。
 */

/** ESLint JSON / Node API 输出中的单条消息（字段全部可选，与 ESLint 实际输出一致） */
export interface EslintMessage {
  /** 规则 id；ESLint 解析错误等场景缺省 */
  ruleId?: string;
  message?: string;
  /** 1-based 行号 */
  line?: number;
  /** 1-based 列号 */
  column?: number;
  /** 1 = warning，2 = error */
  severity?: number;
  /** 致命错误（如配置文件解析失败），仅部分输出形态带 */
  fatal?: boolean;
  /** 自动修复信息；未启用 --fix 或无可修复项时缺省 */
  fix?: unknown;
}
