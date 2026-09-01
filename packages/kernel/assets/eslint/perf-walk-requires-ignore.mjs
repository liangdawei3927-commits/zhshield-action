/**
 * perf-walk-requires-ignore — 禁止手写递归目录遍历函数不忽略 node_modules。
 *
 * 递归遍历项目目录树时若不过滤 node_modules，会遍历依赖/构建产物，拖慢扫描
 * （P0-5 修复：kernel/src/file.ts walk 增加 node_modules 忽略）。
 *
 * 判定（全部满足才报告）：
 * - 函数体内直接包含 readdir / readdirSync / readdirRecursive 调用；
 * - 且函数体内直接包含「对自身的递归调用」或「for/for...of/for...in 循环」；
 * - 且未过滤 node_modules：
 *   - 函数体内无 'node_modules' 字符串字面量；
 *   - 且未引用任何「过滤语义」标识符（skip/noise/ignore/exclude/filter 命名，
 *     覆盖仓库 SKIP_DIRS / NOISE_DIRS / isNoiseDir / isExcludedDir 等约定）；
 *   - 且引用的自由标识符在外层作用域的声明子树中也不含 'node_modules' 字面量
 *     （覆盖 `const SKIP_DIRS = new Set(['node_modules', ...])` 定义在函数外的写法）。
 *
 * 保守性：readdir 与循环/递归均须直接位于函数体（不深入嵌套函数），
 * 避免把「包含 walk 助手的普通函数」误判为遍历函数。
 */
const READDIR_NAMES = new Set(['readdir', 'readdirSync', 'readdirRecursive']);
/** 过滤语义标识符命名启发式（仓库约定：SKIP_DIRS / NOISE_DIRS / isNoiseDir / isExcludedDir ...） */
const FILTER_NAME_RE = /(skip|noise|ignore|exclude|filter)/i;

/** @type {import('eslint').Rule.RuleModule} */
const walkRequiresIgnore = {
  meta: {
    type: 'problem',
    docs: {
      description: '手写递归目录遍历函数必须忽略 node_modules（否则遍历依赖/构建产物拖慢扫描）',
    },
    schema: [],
    messages: {
      walkRequiresIgnore:
        "递归目录遍历函数未忽略 node_modules：请在遍历时跳过 node_modules（如 SKIP_DIRS / entry.name === 'node_modules'）",
    },
  },
  create(context) {
    /** 作用域栈：{ names: Map<name, declarationNode> }，栈底为模块作用域 */
    const scopeStack = [];

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

    function pushChildren(stack, node) {
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

    /** 子树中是否含 'node_modules' 字符串字面量 */
    function containsNodeModulesLiteral(node) {
      if (!node) return false;
      const stack = [node];
      while (stack.length > 0) {
        const n = stack.pop();
        if (!n) continue;
        if (n.type === 'Literal' && n.value === 'node_modules') return true;
        pushChildren(stack, n);
      }
      return false;
    }

    /** 函数名：自身 id，或赋值目标（const walk = ... / this.walk = ... / 方法名） */
    function getFunctionName(node) {
      if (node.id) return node.id.name;
      const parent = node.parent;
      if (!parent) return null;
      if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
        return parent.id.name;
      }
      if (parent.type === 'AssignmentExpression') {
        const left = parent.left;
        if (left.type === 'Identifier') return left.name;
        if (left.type === 'MemberExpression' && left.property.type === 'Identifier') {
          return left.property.name;
        }
      }
      if (parent.type === 'Property' && parent.key.type === 'Identifier') return parent.key.name;
      if (parent.type === 'MethodDefinition' && parent.key.type === 'Identifier') {
        return parent.key.name;
      }
      return null;
    }

    function isReaddirCallee(callee) {
      if (callee.type === 'Identifier') return READDIR_NAMES.has(callee.name);
      if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
        return READDIR_NAMES.has(callee.property.name);
      }
      return false;
    }

    function isSelfCall(callee, fnName) {
      if (callee.type === 'Identifier') return callee.name === fnName;
      if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
        return callee.property.name === fnName;
      }
      return false;
    }

    /** 收集函数内声明的名字（参数 + 函数体声明，不深入嵌套函数） */
    function collectDeclaredNames(fnNode, out) {
      const ids = [];
      for (const p of fnNode.params) collectPatternNames(p, ids);
      for (const id of ids) out.add(id);
      const stack = [fnNode.body];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        if (
          node.type === 'FunctionDeclaration' ||
          node.type === 'FunctionExpression' ||
          node.type === 'ArrowFunctionExpression'
        ) {
          if (node !== fnNode) continue;
        }
        if (node.type === 'VariableDeclaration') {
          const declIds = [];
          for (const d of node.declarations) collectPatternNames(d.id, declIds);
          for (const id of declIds) out.add(id);
        } else if (node.type === 'FunctionDeclaration' && node.id) {
          out.add(node.id.name);
        } else if (node.type === 'ClassDeclaration' && node.id) {
          out.add(node.id.name);
        }
        pushChildren(stack, node);
      }
    }

    /** 构建函数作用域（参数 + 函数体声明 → 声明节点） */
    function buildFunctionScope(fnNode) {
      const names = new Map();
      for (const p of fnNode.params) {
        const ids = [];
        collectPatternNames(p, ids);
        for (const id of ids) names.set(id, p);
      }
      const stack = [fnNode.body];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        if (
          node.type === 'FunctionDeclaration' ||
          node.type === 'FunctionExpression' ||
          node.type === 'ArrowFunctionExpression'
        ) {
          if (node !== fnNode) continue;
        }
        if (node.type === 'VariableDeclaration') {
          for (const d of node.declarations) {
            const ids = [];
            collectPatternNames(d.id, ids);
            for (const id of ids) names.set(id, d);
          }
        } else if (node.type === 'FunctionDeclaration' && node.id) {
          names.set(node.id.name, node);
        } else if (node.type === 'ClassDeclaration' && node.id) {
          names.set(node.id.name, node);
        }
        pushChildren(stack, node);
      }
      return { names };
    }

    /** 在外层作用域查找名字的声明节点（从内向外） */
    function findDeclaration(name) {
      for (let i = scopeStack.length - 1; i >= 0; i--) {
        const scope = scopeStack[i];
        if (scope.names.has(name)) return scope.names.get(name);
      }
      return null;
    }

    function analyzeFunction(fnNode) {
      const fnName = getFunctionName(fnNode);
      const declared = new Set();
      collectDeclaredNames(fnNode, declared);

      // 第一遍：函数体直接内容 —— readdir / 递归自调用 / 循环 / 自由标识符引用
      let hasReaddir = false;
      let hasLoop = false;
      let hasRecursiveCall = false;
      const freeRefs = new Set();
      const stack = [fnNode.body];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        if (
          node.type === 'FunctionDeclaration' ||
          node.type === 'FunctionExpression' ||
          node.type === 'ArrowFunctionExpression'
        ) {
          continue;
        }
        if (node.type === 'CallExpression') {
          if (isReaddirCallee(node.callee)) hasReaddir = true;
          if (fnName && isSelfCall(node.callee, fnName)) hasRecursiveCall = true;
        }
        if (
          node.type === 'ForStatement' ||
          node.type === 'ForOfStatement' ||
          node.type === 'ForInStatement'
        ) {
          hasLoop = true;
        }
        if (node.type === 'Identifier' && !declared.has(node.name)) {
          freeRefs.add(node.name);
        }
        pushChildren(stack, node);
      }

      if (!hasReaddir || !(hasRecursiveCall || hasLoop)) return;

      // 第二遍：整个函数子树 —— 'node_modules' 字面量 + 过滤语义标识符
      if (containsNodeModulesLiteral(fnNode.body)) return;
      let hasFilterNameRef = false;
      const stack2 = [fnNode.body];
      while (stack2.length > 0) {
        const node = stack2.pop();
        if (!node) continue;
        if (node.type === 'Identifier' && FILTER_NAME_RE.test(node.name)) {
          hasFilterNameRef = true;
          break;
        }
        pushChildren(stack2, node);
      }
      if (hasFilterNameRef) return;

      // 自由标识符在外层作用域的声明子树含 'node_modules' → 视为已过滤
      for (const name of freeRefs) {
        const decl = findDeclaration(name);
        if (decl && containsNodeModulesLiteral(decl)) return;
      }

      context.report({ node: fnNode, messageId: 'walkRequiresIgnore' });
    }

    return {
      Program(node) {
        const names = new Map();
        for (const stmt of node.body) {
          if (stmt.type === 'VariableDeclaration') {
            for (const d of stmt.declarations) {
              const ids = [];
              collectPatternNames(d.id, ids);
              for (const id of ids) names.set(id, d);
            }
          } else if (stmt.type === 'FunctionDeclaration' && stmt.id) {
            names.set(stmt.id.name, stmt);
          } else if (stmt.type === 'ClassDeclaration' && stmt.id) {
            names.set(stmt.id.name, stmt);
          } else if (stmt.type === 'ImportDeclaration') {
            for (const s of stmt.specifiers) names.set(s.local.name, s);
          }
        }
        scopeStack.push({ names });
      },
      'Program:exit'() {
        scopeStack.pop();
      },
      'FunctionDeclaration, FunctionExpression, ArrowFunctionExpression'(node) {
        analyzeFunction(node);
        scopeStack.push(buildFunctionScope(node));
      },
      'FunctionDeclaration:exit'() {
        scopeStack.pop();
      },
      'FunctionExpression:exit'() {
        scopeStack.pop();
      },
      'ArrowFunctionExpression:exit'() {
        scopeStack.pop();
      },
    };
  },
};

export default walkRequiresIgnore;
