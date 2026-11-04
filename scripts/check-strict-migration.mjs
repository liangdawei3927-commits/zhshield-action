#!/usr/bin/env node
// @ts-check
/**
 * check-strict-migration.mjs — 类型严格迁移的「棘轮」门禁（报告 §5.2）
 *
 * 背景：根 tsconfig 已永久开启 `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`，
 * 但历史上 15 个包在自己的 tsconfig 里显式关掉并挂 TODO。没有这道门禁，债务会反弹 ——
 * 任何人加一行 `"noUncheckedIndexedAccess": false` 就能把整个包的严格性退回去，
 * 且没有任何东西会红。
 *
 * 判据（四条，全部只看仓库文件 + 一次 tsc，无需完整构建）：
 *   ① **清单内已迁移包**的 tsconfig 不得再出现 `"noUncheckedIndexedAccess": false` /
 *      `"exactOptionalPropertyTypes": false`；
 *   ② **未迁移包的个数不得超过清单记录的基线**（`maxPending`）—— 债可以变少，
 *      不能变多。这是棘轮的核心：新加包必须继承根级严格标志；
 *   ③ 每个**已迁移包**必须真的通过严格检查（tsc 零错误）—— 清单是手写的，
 *      可能与现实脱节；实测编译才是事实；
 *   ④ 被移出清单的包（即"已迁出"）必须仍通过严格检查 —— 防止"迁完又退回"而不被发现。
 *
 * 为什么③不可省：只查"清单里没写 false"，一个包可以在 tsconfig 里写 false 之外的方式
 * 绕过（比如把根 tsconfig 的 extends 去掉）；③ 用真实编译兜底。
 *
 * 用法：node scripts/check-strict-migration.mjs
 * 退出码：0 通过 / 1 有回退或清单与现实不符
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgsDir = join(repoRoot, 'packages');
const manifestPath = join(repoRoot, 'scripts', 'strict-migration.json');
const FLAGS = ['noUncheckedIndexedAccess', 'exactOptionalPropertyTypes'];

/** 读包的 tsconfig（剥掉行注释后解析；tsconfig 允许注释） */
function readTsconfig(pkg) {
  const raw = readFileSync(join(pkgsDir, pkg, 'tsconfig.json'), 'utf-8');
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/** 本包自己的 compilerOptions 是否显式关闭了某标志（extends 的默认值不算"关闭"） */
function isDisabled(pkg, flag) {
  const cfg = readTsconfig(pkg);
  if (!cfg) return false;
  return (cfg.compilerOptions ?? {})[flag] === false;
}

/** 某包在严格标志下能否零错误通过；返回错误数（-1 = 编译失败但非类型错误） */
function strictErrorCount(pkg) {
  try {
    execFileSync(
      'npx',
      ['tsc', '-p', `packages/${pkg}/tsconfig.json`, '--noEmit', '--composite', 'false'],
      { cwd: repoRoot, stdio: 'pipe', timeout: 300000 },
    );
    return 0;
  } catch (err) {
    const stderr = err.stderr?.toString() ?? '';
    return stderr.split('\n').filter((l) => l.includes('error TS')).length;
  }
}

function main() {
  if (!existsSync(manifestPath)) {
    console.error('❌ 缺少迁移清单：scripts/strict-migration.json');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const migrated = manifest.migrated ?? [];
  const compliant = manifest.compliant ?? [];
  const maxPending = manifest.maxPending;
  const allPkgs = readdirSync(pkgsDir).filter((d) => existsSync(join(pkgsDir, d, 'tsconfig.json')));
  const problems = [];

  // 清单自身的一致性：migrated / compliant 必须是真实存在的包，且不重叠
  for (const pkg of [...migrated, ...compliant]) {
    if (!allPkgs.includes(pkg)) problems.push(`清单引用了不存在的包：${pkg}`);
  }
  for (const pkg of migrated) {
    if (compliant.includes(pkg)) problems.push(`${pkg}: 同时出现在 migrated 与 compliant`);
  }

  // ① 已迁移包不得再关闭标志
  for (const pkg of migrated) {
    for (const flag of FLAGS) {
      if (isDisabled(pkg, flag)) problems.push(`${pkg}: 已迁移包不得重新关闭 ${flag}`);
    }
  }

  // ② 棘轮：待迁移包数量不得增加
  const pending = allPkgs.filter((p) => !migrated.includes(p) && !compliant.includes(p));
  if (typeof maxPending === 'number' && pending.length > maxPending) {
    problems.push(
      `待迁移包数量回退：当前 ${pending.length} > 基线 ${maxPending}` +
        `（新增 ${pending.filter((p) => !(manifest.pendingBaseline ?? []).includes(p)).join(', ') || '无'}）`,
    );
  }

  // ③④ 已迁移包必须真的通过严格检查
  for (const pkg of migrated) {
    const errs = strictErrorCount(pkg);
    if (errs !== 0) {
      problems.push(`${pkg}: 清单标记为已合规，但严格类型检查未通过（${errs} 个错误）`);
    }
  }

  if (problems.length > 0) {
    console.error('❌ 类型严格迁移棘轮门禁未通过：');
    for (const p of problems) console.error(`   - ${p}`);
    console.error(
      '\n提示：迁移新包时请更新 scripts/strict-migration.json（migrated / maxPending）',
    );
    process.exit(1);
  }

  console.log(
    `✅ 类型严格迁移棘轮通过（已迁移 ${migrated.length} 包，已合规 ${compliant.length} 包，` +
      `待迁移 ${pending.length} 包 ≤ 基线 ${maxPending}）`,
  );
  if (pending.length > 0) console.log(`   待迁移：${pending.join(', ')}`);
}

main();
