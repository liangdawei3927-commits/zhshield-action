/**
 * perf-no-sync-fs-hotpath — 禁止 async 函数内使用 fs 同步 IO。
 *
 * async 函数内的同步 fs 调用会阻塞事件循环（热路径反模式，P1-7 修复：
 * 主进程 fs 同步 IO → 异步）。本规则在 CI 中强制「async 函数 0 处 sync IO」。
 *
 * 保守启发式：
 * - 仅当调用词法上位于 async 函数体内（最内层函数为 async）才报告；
 *   模块顶层一次性初始化 / 同步函数 / worker 线程文件（同步函数或顶层）不报告。
 * - 仅识别从 'fs' / 'node:fs' 导入的同步方法：
 *   - 命名空间/默认导入：`fs.readFileSync(...)`（属性名以 Sync 结尾，与 no-fs-sync 一致）
 *   - 具名导入：`import { readFileSync } from 'node:fs'` 后 `readFileSync(...)`
 *     （限定在 no-fs-sync 的同步方法名单内，避免误报同名非 fs 函数）
 */
const SYNC_FN_NAMES = new Set([
  'readFileSync',
  'writeFileSync',
  'existsSync',
  'mkdirSync',
  'statSync',
  'readdirSync',
  'renameSync',
  'rmSync',
  'copyFileSync',
  'unlinkSync',
  'appendFileSync',
  'readSync',
  'writeSync',
]);

/** @type {import('eslint').Rule.RuleModule} */
const noSyncFsHotpath = {
  meta: {
    type: 'problem',
    docs: {
      description: 'async 函数内禁止 fs 同步 IO（阻塞事件循环热路径），改用 fs.promises 异步 API',
    },
    schema: [],
    messages: {
      noSyncFsHotpath:
        'async 函数内禁止 fs 同步 IO（会阻塞事件循环热路径），改用 fs.promises 异步 API',
    },
  },
  create(context) {
    /** 函数栈：记录每个函数是否为 async（最内层决定是否处于 async 作用域） */
    const fnStack = [];
    /** 从 'fs' / 'node:fs' 命名空间/默认导入的本地名（如 fs） */
    const fsNamespaceNames = new Set();
    /** 从 'fs' / 'node:fs' 具名导入的本地名（如 readFileSync） */
    const fsNamedImportNames = new Set();

    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (source !== 'fs' && source !== 'node:fs') return;
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportNamespaceSpecifier' || spec.type === 'ImportDefaultSpecifier') {
            fsNamespaceNames.add(spec.local.name);
          } else if (spec.type === 'ImportSpecifier') {
            fsNamedImportNames.add(spec.local.name);
          }
        }
      },
      'FunctionDeclaration, FunctionExpression, ArrowFunctionExpression'(node) {
        fnStack.push(node.async === true);
      },
      'FunctionDeclaration:exit'() {
        fnStack.pop();
      },
      'FunctionExpression:exit'() {
        fnStack.pop();
      },
      'ArrowFunctionExpression:exit'() {
        fnStack.pop();
      },
      CallExpression(node) {
        // 仅最内层函数为 async 时报告
        if (fnStack.length === 0 || !fnStack[fnStack.length - 1]) return;
        const callee = node.callee;
        if (callee.type === 'MemberExpression') {
          const object = callee.object;
          const property = callee.property;
          if (
            object.type === 'Identifier' &&
            fsNamespaceNames.has(object.name) &&
            property.type === 'Identifier' &&
            property.name.endsWith('Sync')
          ) {
            context.report({ node, messageId: 'noSyncFsHotpath' });
            return;
          }
        }
        if (
          callee.type === 'Identifier' &&
          fsNamedImportNames.has(callee.name) &&
          SYNC_FN_NAMES.has(callee.name)
        ) {
          context.report({ node, messageId: 'noSyncFsHotpath' });
        }
      },
    };
  },
};

export default noSyncFsHotpath;
