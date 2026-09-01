import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDependencyGraph,
  buildLicenseMatrix,
  TyposquatDetectorImpl,
  lockfileVerifier,
  UpgradeEvaluatorImpl,
  DEFAULT_UPGRADE_CATALOG,
  EnvConsistencyCheckerImpl,
} from '..';
import type { DependencyNode, ProjectProfile } from '..';

/**
 * 接线层集成测试：模拟 desktop runDepsHandler / CLI runDepsCommand 的编排流程，
 * 用同一个临时 npm 项目跑通全部四个适配器，验证公共导出面（src/index.ts）可直接消费。
 */

/** 创建临时目录并登记清理（与各适配器测试同约定） */
const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

/** 构造 npm v3 项目：lodahs（投毒阳性）+ react（升级目录命中），版本与锁文件一致 */
function buildFixture(dir: string): void {
  writeFile(
    dir,
    'package.json',
    JSON.stringify({
      name: 'app',
      engines: { node: '^20.0.0' },
      dependencies: {
        lodahs: '^4.17.21',
        react: '^18.2.0',
      },
    }),
  );
  writeFile(
    dir,
    'package-lock.json',
    JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/lodahs': { version: '4.17.21', integrity: 'sha512-lodahs-hash' },
        'node_modules/react': { version: '18.2.0', integrity: 'sha512-react-hash' },
      },
    }),
  );
  writeFile(dir, '.nvmrc', '18.20.2\n');
}

describe('依赖盘点接线层（desktop runDeps / CLI deps 同款编排）', () => {
  it('同一项目跑通图谱 + 投毒 + 锁文件 + 升级 + 环境一致性，产出完整报告字段', async () => {
    const dir = tmpDir('zh-deps-runner-');
    buildFixture(dir);

    const graph = buildDependencyGraph(dir);
    const nodes = graph.nodes;
    expect(nodes).toHaveLength(2);

    const matrix = buildLicenseMatrix(graph);
    expect(matrix.total).toBe(2);

    const typosquatFindings = await new TyposquatDetectorImpl().detect(graph);
    const lodahs = typosquatFindings.find((finding) => finding.nodeId === 'lodahs@4.17.21');
    expect(lodahs).toBeDefined();
    expect(lodahs?.risk).toBe('high');
    expect(lodahs?.signals.nameSimilarity?.target).toBe('lodash');
    expect(lodahs?.evidence.length).toBeGreaterThan(0);

    const verification = await lockfileVerifier.verify(dir);
    expect(verification.status).toBe('clean');
    expect(verification.diffs).toEqual([]);
    expect(verification.integrityFailures).toEqual([]);

    const evaluator = new UpgradeEvaluatorImpl();
    const directNodes = nodes.filter(
      (node) => node.kind === 'direct' && node.name in DEFAULT_UPGRADE_CATALOG,
    );
    const assessments = [];
    for (const node of directNodes) {
      assessments.push(await evaluator.evaluate(node));
    }
    expect(assessments).toHaveLength(1);
    expect(assessments[0].nodeId).toBe('react@18.2.0');
    expect(assessments[0].candidates.length).toBeGreaterThan(0);
    expect(assessments[0].candidates[0].targetVersion).toBe('19');

    const profile: ProjectProfile = {
      projectPath: dir,
      language: 'typescript',
      framework: null,
      packageManager: 'npm',
      hasTypeScript: true,
    };
    const envReport = await new EnvConsistencyCheckerImpl().check(profile);
    const runtime = envReport.entries.find(
      (entry) => entry.kind === 'runtime-version' && entry.name === 'node',
    );
    expect(runtime).toBeDefined();
    expect(runtime?.severity).toBe('error');
    expect(runtime?.expected).toBe('.nvmrc: 18.20.2');
    expect(runtime?.actual).toBe('package.json engines.node: ^20.0.0');
  });

  it('无锁文件项目：锁文件校验降级为 missing，其余适配器不抛异常', async () => {
    const dir = tmpDir('zh-deps-no-lock-');
    writeFile(
      dir,
      'package.json',
      JSON.stringify({ name: 'app', dependencies: { react: '^18.2.0' } }),
    );

    const graph = buildDependencyGraph(dir);
    expect(graph.lockfile.present).toBe(false);

    const typosquatFindings = await new TyposquatDetectorImpl().detect(graph);
    expect(Array.isArray(typosquatFindings)).toBe(true);

    const verification = await lockfileVerifier.verify(dir);
    expect(verification.status).toBe('missing');

    const profile: ProjectProfile = {
      projectPath: dir,
      language: 'typescript',
      framework: null,
      packageManager: 'npm',
      hasTypeScript: true,
    };
    const envReport = await new EnvConsistencyCheckerImpl().check(profile);
    expect(Array.isArray(envReport.entries)).toBe(true);
  });

  it('升级评估的 code-scan 在未传 projectRoot 时不执行（防主进程阻塞）', async () => {
    const dir = tmpDir('zh-deps-noscan-');
    writeFile(
      dir,
      'package.json',
      JSON.stringify({ name: 'app', dependencies: { axios: '^0.27.0' } }),
    );
    writeFile(
      dir,
      'package-lock.json',
      JSON.stringify({
        name: 'app',
        lockfileVersion: 3,
        packages: { 'node_modules/axios': { version: '0.27.2', integrity: 'sha512-axios-hash' } },
      }),
    );

    const graph = buildDependencyGraph(dir);
    const axiosNode = graph.nodes.find(
      (node: DependencyNode): node is DependencyNode => node.name === 'axios',
    );
    expect(axiosNode).toBeDefined();

    const assessment = await new UpgradeEvaluatorImpl().evaluate(axiosNode as DependencyNode);
    expect(assessment.nodeId).toBe('axios@0.27.2');
    expect(assessment.candidates.some((candidate) => candidate.targetVersion === '1')).toBe(true);
    for (const candidate of assessment.candidates) {
      expect(candidate.breakingChanges[0].affectedFiles).toEqual([]);
    }
  });
});
