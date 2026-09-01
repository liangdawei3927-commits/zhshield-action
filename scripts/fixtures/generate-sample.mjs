#!/usr/bin/env node
/**
 * 智汇码盾 AutoPerf P2 基准回归门禁 — 固定样本项目生成器
 *
 * 生成 scripts/fixtures/sample-repo/ 下的固定样本项目：
 *  - 一个 package.json
 *  - src/ 下约 50 个小型 .ts/.js 文件（含若干嵌套子目录）
 *  - node_modules/ 下约 15 个小型但结构真实的虚拟包（package.json + index.js + 可选 lib/）
 *  - 内容完全确定（无时间戳/随机数），可重复运行且结果一致（幂等）
 *
 * 用途：固定样本 = 每次运行输入完全相同，计时可比，用于基准回归门禁。
 * node_modules 为“真实大仓快照”的结构占位（AutoPerf P2 计划要求），
 * 但代码是 stub（非真实 npm 包），benchmark 的 countLOC/collectSourceFiles 本就排除 node_modules。
 *
 * 用法：node scripts/fixtures/generate-sample.mjs
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.join(__dirname, 'sample-repo');
const SRC_DIR = path.join(SAMPLE_DIR, 'src');
const NODE_MODULES_DIR = path.join(SAMPLE_DIR, 'node_modules');

// 每个文件的内容模板：确定性、无随机、无时间戳。
function tsModule(name, index) {
  return `// ${name}.ts — 固定样本模块 ${index}（确定性生成，勿手改）
export interface Item${index} {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem${index}(id: number, label: string): Item${index} {
  return { id, label, active: id % 2 === 0 };
}

export function describe${index}(item: Item${index}): string {
  return \`[\${item.id}] \${item.label} (\${item.active ? 'on' : 'off'})\`;
}

export const DEFAULT_ITEMS_${index}: Item${index}[] = Array.from(
  { length: 8 },
  (_, i) => makeItem${index}(i, \`item-\${i}\`)
);
`;
}

function jsModule(name, index) {
  return `// ${name}.js — 固定样本模块 ${index}（确定性生成，勿手改）
function compute${index}(a, b) {
  return a * b + a - b;
}

function format${index}(value) {
  return \`result=\${value}\`;
}

module.exports = { compute${index}, format${index} };
`;
}

// 目录 → 文件清单（确定性顺序）。共 50 个源文件。
const LAYOUT = [
  { dir: 'core', count: 12, kind: 'ts' },
  { dir: 'core/util', count: 8, kind: 'ts' },
  { dir: 'services', count: 10, kind: 'ts' },
  { dir: 'services/adapters', count: 6, kind: 'js' },
  { dir: 'ui', count: 8, kind: 'ts' },
  { dir: 'ui/components', count: 6, kind: 'js' },
];

// ---- node_modules 虚拟包定义（确定性，真实结构但代码为 stub）----
// 每个包：{ name, version, main, stub (index.js 内容), lib?: [{file, content}] }
const PACKAGES = [
  {
    name: 'lodash',
    version: '4.17.21',
    main: 'index.js',
    stub: `// lodash@4.17.21 — stub
function cloneDeep(value) {
  return JSON.parse(JSON.stringify(value));
}
function merge(target, source) {
  return Object.assign({}, target, source);
}
function get(obj, path, def) {
  return obj ?? def;
}
module.exports = { cloneDeep, merge, get };
`,
    lib: [
      {
        file: 'util.js',
        content: `// lodash/internal/util — stub\nfunction isObject(val) {\n  return val !== null && typeof val === 'object';\n}\nmodule.exports = { isObject };\n`,
      },
    ],
  },
  {
    name: 'typescript',
    version: '5.7.3',
    main: 'lib/typescript.js',
    stub: `// typescript@5.7.3 — stub
function createProgram(rootNames, options) {
  return { emit() {}, getTypeChecker() {} };
}
function createSourceFile(filename, text, languageVersion) {
  return { fileName: filename, statements: [] };
}
module.exports = { createProgram, createSourceFile, version: '5.7.3' };
`,
    lib: [
      {
        file: 'compiler.js',
        content: `// typescript/lib/compiler — stub\nfunction compile(sourceFile, options) {\n  return { diagnostics: [], emitSkipped: false };\n}\nmodule.exports = { compile };\n`,
      },
    ],
  },
  {
    name: 'eslint',
    version: '9.22.0',
    main: 'lib/eslint.js',
    stub: `// eslint@9.22.0 — stub
function Linter(options) {
  this.options = options || {};
}
Linter.prototype.verify = function (text, config) {
  return [];
};
module.exports = { Linter };
`,
    lib: [
      {
        file: 'linter.js',
        content: `// eslint/lib/linter — stub\nfunction processRow(row) {\n  return { line: row.line, column: row.column, severity: row.severity };\n}\nmodule.exports = { processRow };\n`,
      },
    ],
  },
  {
    name: 'react',
    version: '19.1.0',
    main: 'index.js',
    stub: `// react@19.1.0 — stub
function createElement(type, props) {
  return { type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) };
}
function useState(initial) {
  return [initial, function () {}];
}
module.exports = { createElement, useState, version: '19.1.0' };
`,
    lib: [
      {
        file: 'component.js',
        content: `// react/lib/component — stub\nfunction Component(props) {\n  this.props = props || {};\n}\nComponent.prototype.render = function () { return null; };\nmodule.exports = { Component };\n`,
      },
    ],
  },
  {
    name: 'vue',
    version: '3.5.13',
    main: 'index.js',
    stub: `// vue@3.5.13 — stub
function createApp(rootComponent) {
  return { mount() {}, unmount() {}, use() {} };
}
function ref(value) {
  return { value, _isRef: true };
}
module.exports = { createApp, ref, version: '3.5.13' };
`,
  },
  {
    name: 'axios',
    version: '1.7.9',
    main: 'index.js',
    stub: `// axios@1.7.9 — stub
function axios(config) {
  return Promise.resolve({ data: null, status: 200, headers: {} });
}
axios.get = function (url) { return axios({ method: 'GET', url }); };
axios.post = function (url, data) { return axios({ method: 'POST', url, data }); };
module.exports = axios;
`,
  },
  {
    name: 'moment',
    version: '2.30.1',
    main: 'index.js',
    stub: `// moment@2.30.1 — stub
function moment(input) {
  return { format: function (f) { return String(input); }, valueOf: function () { return Date.now(); } };
}
moment.utc = function (input) { return moment(input); };
module.exports = moment;
`,
  },
  {
    name: 'dayjs',
    version: '1.11.13',
    main: 'index.js',
    stub: `// dayjs@1.11.13 — stub
function dayjs(input) {
  return { format: function () { return String(input); }, valueOf: function () { return Date.now(); }, add: function () { return dayjs(input); } };
}
dayjs.utc = function (input) { return dayjs(input); };
module.exports = dayjs;
`,
  },
  {
    name: 'chalk',
    version: '5.4.1',
    main: 'source/index.js',
    stub: `// chalk@5.4.1 — stub
function createChalk() {
  return new Proxy({}, { get: function (_, style) { return function (s) { return s; }; } });
}
const chalk = createChalk();
module.exports = { Chalk: createChalk, chalk };
`,
    lib: [
      {
        file: 'ansi-styles.js',
        content: `// chalk/source/ansi-styles — stub\nconst codes = { bold: [1, 22], red: [31, 39], green: [32, 39] };\nmodule.exports = { codes };\n`,
      },
    ],
  },
  {
    name: 'commander',
    version: '13.1.0',
    main: 'index.js',
    stub: `// commander@13.1.0 — stub
function Command(name) {
  this.name = name;
  this.options = [];
}
Command.prototype.option = function (flag, desc) {
  this.options.push({ flag, desc });
  return this;
};
Command.prototype.parse = function () { return this; };
module.exports = { Command };
`,
  },
  {
    name: 'minimatch',
    version: '10.0.1',
    main: 'index.js',
    stub: `// minimatch@10.0.1 — stub
function minimatch(str, pattern) {
  return str.startsWith(pattern.split('*')[0]);
}
function Minimatch(pattern, options) {
  this.pattern = pattern;
  this.options = options || {};
}
Minimatch.prototype.match = function (str) { return minimatch(str, this.pattern); };
module.exports = { minimatch, Minimatch };
`,
  },
  {
    name: 'semver',
    version: '7.7.1',
    main: 'index.js',
    stub: `// semver@7.7.1 — stub
function parse(version) {
  var m = String(version).match(/^v?(\\d+)\\.(\\d+)\\.(\\d+)/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], version: version } : null;
}
function gte(v1, v2) { return compare(v1, v2) >= 0; }
function compare(a, b) { return parse(a).major - parse(b).major || parse(a).minor - parse(b).minor; }
module.exports = { parse, gte, compare, SemVer: parse };
`,
    lib: [
      {
        file: 'classes.js',
        content: `// semver/classes — stub\nfunction SemVer(version) {\n  this.version = version;\n  this.prerelease = [];\n}\nSemVer.prototype.compare = function (other) { return 0; };\nmodule.exports = { SemVer };\n`,
      },
    ],
  },
  {
    name: 'rimraf',
    version: '6.0.1',
    main: 'dist/commonjs/index.js',
    stub: `// rimraf@6.0.1 — stub
var fs = require('fs');
function rimraf(path, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  fs.rm(path, { recursive: true, force: true }, cb || function () {});
}
rimraf.sync = function (p) { fs.rmSync(p, { recursive: true, force: true }); };
module.exports = { rimraf, sync: rimraf.sync };
`,
  },
  {
    name: 'mkdirp',
    version: '3.0.1',
    main: 'index.js',
    stub: `// mkdirp@3.0.1 — stub
var fs = require('fs'), path = require('path');
function mkdirp(dir, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  fs.mkdir(dir, { recursive: true }, cb || function () {});
}
mkdirp.sync = function (d) { fs.mkdirSync(d, { recursive: true }); };
module.exports = { mkdirp, sync: mkdirp.sync };
`,
  },
  {
    name: 'glob',
    version: '11.0.1',
    main: 'dist/commonjs/index.js',
    stub: `// glob@11.0.1 — stub
var fs = require('fs'), path = require('path');
function glob(pattern, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  cb(null, []);
}
glob.sync = function (p) { return []; };
module.exports = { glob, sync: glob.sync };
`,
    lib: [
      {
        file: 'pattern.js',
        content: `// glob/pattern — stub\nfunction Pattern(src, options) {\n  this.src = src;\n  this.options = options || {};\n  this.isGlob = src.indexOf('*') !== -1;\n}\nPattern.prototype.match = function (f) { return f.startsWith(this.src.split('*')[0]); };\nmodule.exports = { Pattern };\n`,
      },
    ],
  },
];

const packageJson = {
  name: 'zhshield-sample-repo',
  version: '1.0.0',
  private: true,
  description: '智汇码盾基准回归门禁固定样本项目（确定性生成）',
  scripts: {
    test: 'echo "sample-repo has no tests"',
  },
};

async function main() {
  // 先清空再重建，保证幂等（每次内容一致）。
  await rm(SAMPLE_DIR, { recursive: true, force: true });
  await mkdir(SRC_DIR, { recursive: true });
  await mkdir(NODE_MODULES_DIR, { recursive: true });

  // 先并行创建所有子目录（mkdir recursive 会连带创建父目录），再并行写文件，
  // 保证目录先于其内文件存在，同时避免循环内串行 await。
  await Promise.all(LAYOUT.map(({ dir }) => mkdir(path.join(SRC_DIR, dir), { recursive: true })));

  const writes = [
    writeFile(
      path.join(SAMPLE_DIR, 'package.json'),
      JSON.stringify(packageJson, null, 2) + '\n',
      'utf-8',
    ),
  ];

  let index = 0;
  for (const { dir, count, kind } of LAYOUT) {
    const targetDir = path.join(SRC_DIR, dir);
    for (let i = 0; i < count; i++) {
      const name = `${dir.replace(/[^a-z]/g, '')}${i + 1}`;
      const ext = kind === 'ts' ? 'ts' : 'js';
      const content = kind === 'ts' ? tsModule(name, index) : jsModule(name, index);
      writes.push(writeFile(path.join(targetDir, `${name}.${ext}`), content, 'utf-8'));
      index++;
    }
  }

  // node_modules 虚拟包：每个包一个目录，含 package.json + index.js（+ 可选 lib/）。
  let pkgCount = 0;
  for (const pkg of PACKAGES) {
    const pkgDir = path.join(NODE_MODULES_DIR, pkg.name);
    await mkdir(pkgDir, { recursive: true });
    writes.push(
      writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify(
          { name: pkg.name, version: pkg.version, main: pkg.main, license: 'MIT' },
          null,
          2,
        ) + '\n',
        'utf-8',
      ),
      writeFile(path.join(pkgDir, 'index.js'), pkg.stub, 'utf-8'),
    );
    if (pkg.lib) {
      const libDir = path.join(pkgDir, 'lib');
      await mkdir(libDir, { recursive: true });
      for (const f of pkg.lib) {
        writes.push(writeFile(path.join(libDir, f.file), f.content, 'utf-8'));
      }
    }
    pkgCount++;
  }

  await Promise.all(writes);

  console.log(`✅ 固定样本项目已生成：${SAMPLE_DIR}`);
  console.log(`   源文件数：${index}`);
  console.log(`   node_modules 虚拟包数：${pkgCount}`);
}

main().catch((err) => {
  console.error('生成失败：', err);
  process.exit(1);
});
