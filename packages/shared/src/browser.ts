/**
 * 渲染进程安全入口（browser.ts）
 *
 * 为什么需要它：渲染进程是沙箱（`nodeIntegration: false`），而 `@zh/shared` 的根入口
 * `index.ts` 会把 Node 专属实现一起打进浏览器包 —— 其中 `tool-run-scope` →
 * `tool-exec-primitives` 在模块顶层执行 `promisify(execFile)`，浏览器侧 `node:util`
 * 只是一个空 shim，于是初始化瞬间就抛 `(0, n.promisify) is not a function`：
 * 整个 React 树挂载失败，页面只剩空的 `#root`（白屏，控制台只有一行看不懂的报错）。
 *
 * 与 `@zh/kernel` 的 `src/browser.ts` 同构，由 desktop 的 vite alias 把 `@zh/shared`
 * 指到本文件。
 *
 * **安全边界以「模块」为单位，不逐符号挑选**：这里 `export *` 的每个模块都必须整份
 * 无 Node 依赖。要新增一个模块进来，先确认它不 import `node:*` / `fs` / `child_process`
 * —— 否则等于把白屏换个位置藏起来。
 */
export * from './capability-registry';
export * from './score-dimensions';
export type { DomainId } from './domain-contract/types';
