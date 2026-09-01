/**
 * perf-no-serial-await — 禁止 for/for...of 循环体内串行 await 独立调用。
 *
 * 循环体内 `await foo()` 若调用不依赖循环变量（即每次迭代的调用彼此独立），
 * 串行执行会按迭代次数累加延迟；应改用 Promise.all 并行化（P0-1 修复：
 * tool-adapter-executor 串行 for...await → 有界并行池 + Promise.all）。
 *
 * 保守启发式（避免误报）：
 * - 仅检查 for / for...of 循环（while 循环不检查）。
 * - 仅当 await 的参数是「调用表达式」（`await foo()`），而非变量（`await x`）。
 * - 仅当被 await 的调用整体（callee + 实参）不引用循环变量 —— 若引用则可能
 *   依赖迭代顺序/结果，无法安全并行化，跳过。
 * - 不深入嵌套函数（嵌套函数内的 await 不由外层循环串行化）。
 * - 不深入嵌套循环（内层循环的 await 归内层循环判定，避免重复报告）。
 */
const noSerialAwait = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'for/for...of 循环体内 await 独立调用（不依赖循环变量）应改用 Promise.all 并行化',
    },
    schema: [],
    messages: {
      noSerialAwait:
        '循环体内 await 的调用不依赖循环变量，可并行化：改用 Promise.all(...) 替代串行 await',
    },
  },
  create(context) {
    /** 收集循环绑定的变量名（for...of 的 left / for 的 init 声明） */
    function collectLoopVarNames(node) {
      const names = [];
      if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
        const left = node.left;
        if (left.type === 'VariableDeclaration') {
          for (const d of left.declarations) collectPatternNames(d.id, names);
        } else {
          collectPatternNames(left, names);
        }
      } else if (node.type === 'ForStatement') {
        const init = node.init;
        if (init && init.type === 'VariableDeclaration') {
          for (const d of init.declarations) collectPatternNames(d.id, names);
        } else if (init && init.type === 'AssignmentExpression') {
          collectPatternNames(init.left, names);
        }
      }
      return names;
    }

    /** 收集解构模式中的标识符名 */
    function collectPatternNames(pattern, out) {
      if (!pattern) return;
      switch (pattern.type) {
        case 'Identifier':
          out.push(pattern.name);
          break;
        case 'ObjectPattern':
          for (const prop of pattern.properties) {
            collectPatternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out);
          }
          break;
        case 'ArrayPattern':
          for (const el of pattern.elements) collectPatternNames(el, out);
          break;
        case 'RestElement':
          collectPatternNames(pattern.argument, out);
          break;
        case 'AssignmentPattern':
          collectPatternNames(pattern.left, out);
          break;
        default:
          break;
      }
    }

    /** 子树中是否出现任一给定名字的标识符引用 */
    function containsIdentifier(node, names) {
      if (!node) return false;
      if (node.type === 'Identifier') return names.includes(node.name);
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
        if (child && typeof child.type === 'string') {
          if (containsIdentifier(child, names)) return true;
        } else if (Array.isArray(child)) {
          for (const c of child) {
            if (c && typeof c.type === 'string' && containsIdentifier(c, names)) return true;
          }
        }
      }
      return false;
    }

    /** 收集循环体内直接出现的 AwaitExpression（不深入嵌套函数 / 嵌套循环） */
    function findAwaitsInBody(body) {
      const awaits = [];
      const stack = [body];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        if (node.type === 'AwaitExpression') {
          awaits.push(node);
          continue;
        }
        if (
          node.type === 'FunctionDeclaration' ||
          node.type === 'FunctionExpression' ||
          node.type === 'ArrowFunctionExpression' ||
          node.type === 'ForStatement' ||
          node.type === 'ForOfStatement' ||
          node.type === 'ForInStatement'
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
      return awaits;
    }

    function checkLoop(node) {
      const loopVars = collectLoopVarNames(node);
      // 无法识别循环变量（如 for(;;)）→ 保守跳过
      if (loopVars.length === 0) return;
      for (const awaitNode of findAwaitsInBody(node.body)) {
        const arg = awaitNode.argument;
        // 仅当 await 的是调用表达式（`await foo()`），变量 await（`await x`）不检查
        if (!arg || arg.type !== 'CallExpression') continue;
        // 调用整体引用循环变量 → 可能依赖迭代，跳过
        if (containsIdentifier(arg, loopVars)) continue;
        context.report({ node: awaitNode, messageId: 'noSerialAwait' });
      }
    }

    return {
      ForOfStatement: checkLoop,
      ForStatement: checkLoop,
    };
  },
};

export default noSerialAwait;
