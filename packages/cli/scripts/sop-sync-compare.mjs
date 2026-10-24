// @ts-check
/**
 * SOP 规则资产「源码 ↔ 发布产物」漂移比较（单一实现）
 *
 * 为什么独立成模块：这条判据被两个消费方共用 ——
 *   ① scripts/verify-sop-sync.mjs（CI 与本地手动校验，输出 + 退出码）
 *   ② src/__tests__/sop-dist-sync.test.ts（pnpm test 时自动跑，且要能用合成样本反证"判据会红"）
 * 若两处各写一份比较逻辑，它们迟早会不一致，而这条检查的对象正是"两份拷贝必须一致"——
 * 判据自身分叉会比被测对象分叉更难发现。
 *
 * 只做纯读取与比较，不写文件、不调 process.exit，便于在测试里直接断言。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * @typedef {object} SopSyncResult
 * @property {boolean} ok          两侧完全一致且目录都存在
 * @property {number} checked      参与比较的文件数（源码侧）
 * @property {string[]} missing    仅源码侧存在（尚未拷进产物）
 * @property {string[]} extra      仅产物侧存在（源码已删但产物残留）
 * @property {string[]} differing  两侧都有但内容不一致
 * @property {string[]} problems   目录缺失等前置问题（非空即判失败，绝不静默通过）
 */

/**
 * 递归收集目录下所有文件的相对路径（按路径排序）。只收文件，不含目录项。
 * @param {string} dir
 * @returns {string[]}
 */
export function collectSopTreeFiles(dir) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} current */
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(relative(dir, full));
    }
  };
  walk(dir);
  return files.sort();
}

/**
 * 单个文件的 SHA-256 摘要（按原始字节比较，不做换行归一化：
 * 两侧都由同一个 git checkout 产出，换行策略一致）。
 * @param {string} filePath
 * @returns {string}
 */
function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * @param {string} dir
 * @returns {Map<string, string>} 相对路径 → 摘要
 */
function snapshot(dir) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const rel of collectSopTreeFiles(dir)) map.set(rel, sha256(join(dir, rel)));
  return map;
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function isDir(p) {
  return statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * 比较源码树与产物树。
 *
 * 关键安全属性：目录不存在 / 为空一律判失败。历史上本项目出现过
 * 「验证装置被被测流程重置」的假绿（build 先跑、校验后跑），
 * 故这里不允许任何"读不到就当作没问题"的分支。
 *
 * @param {string} srcDir 规则源码目录（packages/kernel/src/sop）
 * @param {string} dstDir 发布产物目录（packages/cli/dist/sop）
 * @returns {SopSyncResult}
 */
export function compareSopTrees(srcDir, dstDir) {
  /** @type {string[]} */
  const problems = [];
  if (!isDir(srcDir)) problems.push(`源码目录不存在: ${srcDir}`);
  if (!isDir(dstDir)) problems.push(`产物目录不存在（请先构建）: ${dstDir}`);
  if (problems.length > 0) {
    return { ok: false, checked: 0, missing: [], extra: [], differing: [], problems };
  }

  const src = snapshot(srcDir);
  const dst = snapshot(dstDir);
  if (src.size === 0) {
    return {
      ok: false,
      checked: 0,
      missing: [],
      extra: [],
      differing: [],
      problems: [`源码目录为空（读不到任何文件，不可判为同步）: ${srcDir}`],
    };
  }

  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const extra = [];
  /** @type {string[]} */
  const differing = [];

  for (const rel of src.keys()) if (!dst.has(rel)) missing.push(rel);
  for (const rel of dst.keys()) if (!src.has(rel)) extra.push(rel);
  for (const [rel, hash] of src) {
    const other = dst.get(rel);
    if (other !== undefined && other !== hash) differing.push(rel);
  }

  return {
    ok: missing.length === 0 && extra.length === 0 && differing.length === 0,
    checked: src.size,
    missing,
    extra,
    differing,
    problems,
  };
}

/**
 * 把比较结果转成可读的漂移描述行（给 CLI 打印用）。
 * @param {SopSyncResult} result
 * @returns {string[]}
 */
export function describeSopSyncProblems(result) {
  return [
    ...result.problems,
    ...result.missing.map((rel) => `仅存在于 kernel/src/sop: ${rel}`),
    ...result.extra.map((rel) => `仅存在于 dist/sop: ${rel}`),
    ...result.differing.map((rel) => `内容不一致: ${rel}`),
  ];
}
