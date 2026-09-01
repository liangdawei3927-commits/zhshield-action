/**
 * perf-batch-db-write — 禁止循环体内 db.prepare(...).run/get/all 单行写入。
 *
 * better-sqlite3 在循环体内逐行 `db.prepare(...).run(...)` 会反复编译 SQL 且
 * 每行独立提交（无事务），写入大量数据时极慢（P1-6 修复：db/src/queries.ts
 * 单行 prepare().run() → db/src/batch.ts 批量事务 API）。
 *
 * 保守启发式：
 * - 仅检查 for / for...of / forEach 循环体。
 * - 仅当循环体内出现「成员表达式以 .prepare( 结尾，且同一链式调用后跟
 *   .run( / .get( / .all(」的调用（即 `X.prepare(...).run(...)` 链式形态）。
 * - 不深入嵌套函数（嵌套函数内的 db 调用不由外层循环直接驱动）。
 * - 循环体外 prepare、循环体内仅 `stmt.run(...)`（复用 prepared statement）
 *   的写法不报告 —— 那是已修复的批量事务模式。
 */
const WRITE_METHODS = new Set(['run', 'get', 'all']);

/** @type {import('eslint').Rule.RuleModule} */
const batchDbWrite = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '循环体内 db.prepare(...).run/get/all 单行写入应改为批量事务（better-sqlite3 transaction）',
    },
    schema: [],
    messages: {
      noBatchDbWrite:
        '循环体内 db.prepare(...).run(...) 单行写入：应提取 prepared statement 并用 db.transaction 批量提交',
    },
  },
  create(context) {
    /** 是否为 `X.prepare(...).run/get/all(...)` 链式调用 */
    function isDbWriteChain(node) {
      if (!node || node.type !== 'CallExpression') return false;
      const callee = node.callee;
      if (callee.type !== 'MemberExpression') return false;
      const prop = callee.property;
      if (prop.type !== 'Identifier' || !WRITE_METHODS.has(prop.name)) return false;
      const obj = callee.object;
      if (!obj || obj.type !== 'CallExpression') return false;
      const objCallee = obj.callee;
      if (!objCallee || objCallee.type !== 'MemberExpression') return false;
      const objProp = objCallee.property;
      return objProp.type === 'Identifier' && objProp.name === 'prepare';
    }

    /** 在子树中查找 db 写入链（不深入嵌套函数） */
    function findDbWriteInBody(body) {
      const stack = [body];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        if (isDbWriteChain(node)) return node;
        if (
          node.type === 'FunctionDeclaration' ||
          node.type === 'FunctionExpression' ||
          node.type === 'ArrowFunctionExpression'
        ) {
          continue;
        }
        for (const key of Object.keys(node)) {
          if (
            key === 'parent' ||
            key === 'loc' ||
            key === 'range' ||
            key === 'tokens' ||
            key === 'comments'
          ) {
            continue;
          }
          const child = node[key];
          if (child && typeof child.type === 'string') stack.push(child);
          else if (Array.isArray(child)) {
            for (const c of child) if (c && typeof c.type === 'string') stack.push(c);
          }
        }
      }
      return null;
    }

    function checkLoopBody(body) {
      const hit = findDbWriteInBody(body);
      if (hit) context.report({ node: hit, messageId: 'noBatchDbWrite' });
    }

    return {
      ForStatement(node) {
        checkLoopBody(node.body);
      },
      ForOfStatement(node) {
        checkLoopBody(node.body);
      },
      CallExpression(node) {
        // forEach：回调函数体即循环体
        const callee = node.callee;
        if (callee.type !== 'MemberExpression') return;
        const prop = callee.property;
        if (prop.type !== 'Identifier' || prop.name !== 'forEach') return;
        const cb = node.arguments[0];
        if (!cb) return;
        if (cb.type !== 'ArrowFunctionExpression' && cb.type !== 'FunctionExpression') return;
        checkLoopBody(cb.body);
      },
    };
  },
};

export default batchDbWrite;
