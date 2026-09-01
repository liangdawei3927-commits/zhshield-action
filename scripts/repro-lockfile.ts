/**
 * 复现脚本：验证 buildDependencyGraph + lockfileVerifier 对真实项目的锁文件判定。
 * 用法：npx tsx scripts/repro-lockfile.ts <projectPath>
 *
 * 修复前：直接以 projectPath 探测锁文件，workspace 子包/父目录扫描 → present:false（误报缺失）。
 * 修复后：先 resolveProjectRoot 再构建图谱/校验，锁文件存在于祖先目录时也能正确识别。
 */
import { buildDependencyGraph } from '../packages/dependency/src/graph-builder';
import { lockfileVerifier } from '../packages/dependency/src/adapters/lockfile-verifier';
import { resolveProjectRoot } from '../packages/dependency/src/adapters/project-root';

async function main() {
  const projectPath = parseProjectPath();
  const root = resolveProjectRoot(projectPath);
  logScanStart(projectPath, root);

  const graph = buildDependencyGraph(root, { targetId: projectPath });
  logGraphSummary(graph);

  const verification = await lockfileVerifier.verify(root);
  logVerificationSummary(verification);
}

/** 解析并校验命令行参数，缺失时打印用法并退出 */
function parseProjectPath(): string {
  const projectPath = process.argv[2];
  if (!projectPath) {
    console.error('用法: npx tsx scripts/repro-lockfile.ts <projectPath>');
    process.exit(1);
  }
  return projectPath;
}

/** 打印项目根目录解析结果 */
function logScanStart(projectPath: string, root: string): void {
  console.log('=== 扫描项目:', projectPath, '===');
  const resolvedElsewhere = root !== projectPath;
  console.log(
    'resolveProjectRoot →',
    root,
    resolvedElsewhere ? '(向上/向下解析到锁文件所在目录)' : '(未解析，锁文件判定在所选目录处)',
  );
}

/** 打印依赖图摘要 */
function logGraphSummary(graph: ReturnType<typeof buildDependencyGraph>): void {
  console.log('--- buildDependencyGraph ---');
  console.log('ecosystem:', graph.ecosystem);
  console.log('nodes:', graph.nodes.length, 'edges:', graph.edges.length);
  console.log('lockfile:', graph.lockfile);
  console.log(
    'direct 节点:',
    graph.nodes
      .filter((n) => n.kind === 'direct')
      .map(
        (n) =>
          `${n.name}@${n.version} declared=${n.declaredRange} integrity=${n.integrity ? 'Y' : 'N'}`,
      ),
  );
}

/** 打印锁文件校验结果 */
function logVerificationSummary(
  verification: Awaited<ReturnType<typeof lockfileVerifier.verify>>,
): void {
  console.log('--- lockfileVerifier.verify ---');
  console.log('status:', verification.status);
  console.log('lockfilePath:', verification.lockfilePath ?? '(null)');
  console.log('diffs:', verification.diffs);
  console.log('integrityFailures:', verification.integrityFailures);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
