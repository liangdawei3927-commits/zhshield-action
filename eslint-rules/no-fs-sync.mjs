/**
 * no-fs-sync — 禁止主进程使用 node:fs 同步 IO。
 *
 * 主进程同步 fs 调用会阻塞 Electron 主线程（扫描卡顿 / “应用未响应”）。
 * 本规则在 CI 中强制“主进程 0 处 sync IO”，防止回归。
 * worker 线程文件（如 profile-worker.ts）在独立线程运行，阻塞 IO 合法，已单独豁免。
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
const noFsSync = {
  meta: {
    type: 'problem',
    docs: {
      description: '主进程禁止 fs 同步 IO，改用 fs.promises 异步 API（worker 线程除外）',
    },
    schema: [],
    messages: {
      noFsSync: '主进程禁止 fs 同步 IO，改用 fs.promises 异步 API（worker 线程除外）',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === 'MemberExpression') {
          const object = callee.object;
          const property = callee.property;
          if (
            object.type === 'Identifier' &&
            object.name === 'fs' &&
            property.type === 'Identifier' &&
            property.name.endsWith('Sync')
          ) {
            context.report({ node, messageId: 'noFsSync' });
            return;
          }
        }
        if (callee.type === 'Identifier' && SYNC_FN_NAMES.has(callee.name)) {
          context.report({ node, messageId: 'noFsSync' });
        }
      },
    };
  },
};

export default noFsSync;
