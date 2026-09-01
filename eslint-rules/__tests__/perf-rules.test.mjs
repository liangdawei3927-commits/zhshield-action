/**
 * perf-* 规则集 RuleTester 测试。
 *
 * 运行：node eslint-rules/__tests__/perf-rules.test.mjs
 * 每条规则至少 1 个 valid（已修复模式）+ 1 个 invalid（反模式）。
 * 纯 ESTree 结构规则，无需 typescript-eslint parser。
 */
import { RuleTester } from 'eslint';
import perfNoSerialAwait from '../perf-no-serial-await.mjs';
import perfNoSyncFsHotpath from '../perf-no-sync-fs-hotpath.mjs';
import perfWalkRequiresIgnore from '../perf-walk-requires-ignore.mjs';
import perfBatchDbWrite from '../perf-batch-db-write.mjs';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

let failures = 0;

function run(name, rule, tests) {
  try {
    ruleTester.run(name, rule, tests);
    console.log(`✓ ${name}: ${tests.valid.length} valid + ${tests.invalid.length} invalid 通过`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${name} 失败`);
    console.error(err && err.message ? err.message : String(err));
  }
}

// ─── perf-no-serial-await ────────────────────────────────────────────────
run('perf-no-serial-await', perfNoSerialAwait, {
  valid: [
    // 已修复：Promise.all 并行化
    'const results = await Promise.all(items.map((item) => process(item)));',
    // 循环变量作为实参 → 可能依赖迭代，不报告
    'for (const item of items) { await process(item); }',
    // 循环变量出现在被 await 调用的 callee → 依赖迭代，不报告
    'for (const item of items) { await item.process(); }',
    // for 循环变量作为实参 → 不报告
    'for (let i = 0; i < n; i++) { await process(i); }',
    // await 变量（非调用表达式）→ 不报告
    'for (const item of items) { await value; }',
    // while 循环不在检查范围
    'while (queue.length) { await process(); }',
  ],
  invalid: [
    {
      // 反模式：for...of 内 await 独立调用（不依赖循环变量）→ 应 Promise.all
      code: 'for (const item of items) { await process(); }',
      errors: [{ messageId: 'noSerialAwait' }],
    },
    {
      // 反模式：for 循环内 await 独立调用
      code: 'for (let i = 0; i < n; i++) { await fetchData(); }',
      errors: [{ messageId: 'noSerialAwait' }],
    },
    {
      // 反模式：await 独立调用位于 if 分支内
      code: 'for (const item of items) { if (flag) { await save(); } }',
      errors: [{ messageId: 'noSerialAwait' }],
    },
  ],
});

// ─── perf-no-sync-fs-hotpath ─────────────────────────────────────────────
run('perf-no-sync-fs-hotpath', perfNoSyncFsHotpath, {
  valid: [
    // 已修复：async 函数内用 fs.promises 异步 API
    "import * as fs from 'node:fs'; async function main() { const data = await fs.promises.readFile('x'); }",
    // 同步函数内同步 fs → 合法
    "import { readFileSync } from 'node:fs'; function main() { const data = readFileSync('x'); }",
    // 模块顶层一次性初始化 → 合法
    "import * as fs from 'node:fs'; const data = fs.readFileSync('x');",
    // async 函数内无同步 fs 调用
    "import { readFileSync } from 'node:fs'; async function main() { const data = await readAsync('x'); }",
    // 非 fs 来源的同名函数不报告
    "import { readFileSync } from 'other-lib'; async function main() { const data = readFileSync('x'); }",
  ],
  invalid: [
    {
      // 反模式：async 函数内 fs.*Sync 命名空间调用
      code: "import * as fs from 'node:fs'; async function main() { const data = fs.readFileSync('x'); }",
      errors: [{ messageId: 'noSyncFsHotpath' }],
    },
    {
      // 反模式：async 函数内具名导入的同步 fs 调用
      code: "import { readFileSync } from 'node:fs'; async function main() { const data = readFileSync('x'); }",
      errors: [{ messageId: 'noSyncFsHotpath' }],
    },
    {
      // 反模式：async 箭头函数内同步 fs
      code: "import { readdirSync } from 'fs'; const main = async () => { readdirSync('x'); };",
      errors: [{ messageId: 'noSyncFsHotpath' }],
    },
  ],
});

// ─── perf-walk-requires-ignore ───────────────────────────────────────────
run('perf-walk-requires-ignore', perfWalkRequiresIgnore, {
  valid: [
    // 已修复（P0-5）：模块级 SKIP_DIRS 含 node_modules，walk 引用之
    `import * as fs from 'node:fs';
     import * as path from 'node:path';
     const SKIP_DIRS = new Set(['node_modules', 'dist', 'build']);
     function walk(dir) {
       const entries = fs.readdirSync(dir, { withFileTypes: true });
       for (const entry of entries) {
         if (entry.isDirectory()) {
           if (SKIP_DIRS.has(entry.name)) continue;
           walk(path.join(dir, entry.name));
         }
       }
     }`,
    // 函数体内直接过滤 node_modules 字面量
    `import * as fs from 'node:fs';
     function walk(dir) {
       const entries = fs.readdirSync(dir);
       for (const entry of entries) {
         if (entry.name === 'node_modules') continue;
         walk(dir + '/' + entry.name);
       }
     }`,
    // 引用过滤语义辅助函数（isNoiseDir 命名）
    `import * as fs from 'node:fs';
     function isNoiseDir(name) { return name === 'node_modules'; }
     function walk(dir) {
       const entries = fs.readdirSync(dir);
       for (const entry of entries) {
         if (entry.isDirectory() && !isNoiseDir(entry.name)) walk(dir + '/' + entry.name);
       }
     }`,
    // 单层扫描（无循环、无递归）→ 不报告
    `import * as fs from 'node:fs';
     function listFiles(dir) {
       return fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
     }`,
    // 仅 readdir 无循环/递归 → 不报告
    `import * as fs from 'node:fs';
     function readDir(dir) {
       return fs.readdirSync(dir);
     }`,
  ],
  invalid: [
    {
      // 反模式：递归遍历且不忽略 node_modules
      code: `import * as fs from 'node:fs';
             function walk(dir) {
               const entries = fs.readdirSync(dir, { withFileTypes: true });
               for (const entry of entries) {
                 if (entry.isDirectory()) {
                   walk(dir + '/' + entry.name);
                 }
               }
             }`,
      errors: [{ messageId: 'walkRequiresIgnore' }],
    },
    {
      // 反模式：readdir + for 循环遍历目录项且不忽略 node_modules
      code: `import * as fs from 'node:fs';
             function scan(dir) {
               const entries = fs.readdirSync(dir);
               for (const entry of entries) {
                 console.log(entry);
               }
             }`,
      errors: [{ messageId: 'walkRequiresIgnore' }],
    },
  ],
});

// ─── perf-batch-db-write ─────────────────────────────────────────────────
run('perf-batch-db-write', perfBatchDbWrite, {
  valid: [
    // 已修复（P1-6）：prepared statement 提取到循环外 + db.transaction 批量提交
    `const insert = db.prepare('INSERT INTO t (id) VALUES (?)');
     db.transaction((rows) => {
       for (const r of rows) insert.run(r.id);
     })(rows);`,
    // 循环体内无 db 写入
    'for (const row of rows) { console.log(row); }',
    // 循环体外 prepare().run()（单次写入，非循环）
    "db.prepare('INSERT INTO t (id) VALUES (?)').run(1);",
    // forEach 回调内复用循环外 prepared statement
    `const insert = db.prepare('INSERT INTO t (id) VALUES (?)');
     rows.forEach((r) => insert.run(r.id));`,
  ],
  invalid: [
    {
      // 反模式：for...of 循环体内 db.prepare(...).run(...) 链式单行写入
      code: `for (const row of rows) {
               db.prepare('INSERT INTO t (id) VALUES (?)').run(row.id);
             }`,
      errors: [{ messageId: 'noBatchDbWrite' }],
    },
    {
      // 反模式：for 循环体内 .prepare(...).get(...)
      code: `for (let i = 0; i < ids.length; i++) {
               db.prepare('SELECT * FROM t WHERE id = ?').get(ids[i]);
             }`,
      errors: [{ messageId: 'noBatchDbWrite' }],
    },
    {
      // 反模式：forEach 回调体内 db.prepare(...).run(...)
      code: `rows.forEach((row) => {
               db.prepare('INSERT INTO t (id) VALUES (?)').run(row.id);
             });`,
      errors: [{ messageId: 'noBatchDbWrite' }],
    },
  ],
});

if (failures > 0) {
  console.error(`\n${failures} 条规则测试失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部 perf-* 规则测试通过');
}
