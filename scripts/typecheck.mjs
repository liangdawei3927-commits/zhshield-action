// 独立类型检查脚本：遍历 packages/* 下所有含 tsconfig.json 的包，
// 运行 tsc --noEmit --composite false（避免 composite 项目的 emit 限制）。
// 用法：node scripts/typecheck.mjs   （或 pnpm typecheck）
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const pkgsDir = join(root, 'packages');

if (!existsSync(pkgsDir)) {
  console.error('未找到 packages/ 目录，请在仓库根目录运行');
  process.exit(1);
}

const pkgs = readdirSync(pkgsDir).filter(
  (d) => d !== 'node_modules' && existsSync(join(pkgsDir, d, 'tsconfig.json')),
);

console.log(`\n类型检查 ${pkgs.length} 个包：${pkgs.join(', ')}\n`);

const failed = [];
for (const pkg of pkgs) {
  process.stdout.write(`  ${pkg.padEnd(14)} `);
  try {
    execSync(`npx tsc --noEmit --composite false -p packages/${pkg}/tsconfig.json`, {
      stdio: 'pipe',
      cwd: root,
    });
    console.log('✓ ok');
  } catch {
    console.log('✗ FAIL');
    failed.push(pkg);
  }
}

if (failed.length) {
  console.error(`\n❌ 类型检查失败：${failed.join(', ')}`);
  console.error(
    '请运行 `pnpm --filter @zh/<pkg> exec tsc --noEmit --composite false` 查看详细错误\n',
  );
  process.exit(1);
}
console.log('\n✅ 全部包类型检查通过\n');
