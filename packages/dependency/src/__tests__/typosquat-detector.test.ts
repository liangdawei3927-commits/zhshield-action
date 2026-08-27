import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDependencyGraph } from '../graph-builder';
import {
  KNOWN_PACKAGES,
  COMMON_TARGETS,
  TyposquatDetectorImpl,
  HIGH_RISK_MAX_EDIT_DISTANCE,
  MEDIUM_RISK_MAX_EDIT_DISTANCE,
  LOW_RISK_MAX_EDIT_DISTANCE,
} from '../adapters/typosquat-detector';

const EDIT_DISTANCE_RE = /edit distance 1/;
const SCORE_RE = /score \d+\.\d{2}/;

/** 创建临时目录并登记清理（与 graph-builder.test.ts 同约定） */
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

/** 构造含指定依赖的 npm v3 项目，返回真实 package-lock.json 构建出的图谱 */
function buildNpmGraph(deps: Record<string, string>): ReturnType<typeof buildDependencyGraph> {
  const dir = tmpDir('zh-dep-typosquat-');
  writeFile(dir, 'package.json', JSON.stringify({ name: 'app', dependencies: deps }));
  const packages: Record<string, unknown> = { '': { name: 'app', dependencies: deps } };
  for (const [name, version] of Object.entries(deps)) {
    packages[`node_modules/${name}`] = {
      version,
      integrity: `sha512-${name}-hash`,
      license: 'MIT',
    };
  }
  writeFile(dir, 'package-lock.json', JSON.stringify({ name: 'app', lockfileVersion: 3, packages }));
  return buildDependencyGraph(dir);
}

const detector = new TyposquatDetectorImpl();

describe('TyposquatDetectorImpl 基本契约', () => {
  it('导出知名包清单：npm ≥ 20、python ≥ 10，且包含样例目标', () => {
    expect(KNOWN_PACKAGES.length).toBeGreaterThanOrEqual(30);
    expect(KNOWN_PACKAGES).toContain('lodash');
    expect(KNOWN_PACKAGES).toContain('js-toolbox');
    expect(KNOWN_PACKAGES).toContain('requests');
    expect(KNOWN_PACKAGES).toContain('flask');
    expect(COMMON_TARGETS.has('lodash')).toBe(true);
  });

  it('导出命名阈值常量', () => {
    expect(HIGH_RISK_MAX_EDIT_DISTANCE).toBe(1);
    expect(MEDIUM_RISK_MAX_EDIT_DISTANCE).toBe(2);
    expect(LOW_RISK_MAX_EDIT_DISTANCE).toBe(3);
  });
});

describe('TyposquatDetectorImpl detect（附 B.6 验收）', () => {
  it("命中 'lodahs' → 目标 lodash，risk=high", async () => {
    const graph = buildNpmGraph({ lodahs: '1.0.0' });
    const findings = await detector.detect(graph);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.nodeId).toBe('lodahs@1.0.0');
    expect(finding.risk).toBe('high');
    expect(finding.signals.nameSimilarity?.target).toBe('lodash');
    expect(finding.signals.nameSimilarity?.score).toBeGreaterThan(0.8);
  });

  it("命中 'js-toolb0x' → 视觉混淆 js-toolbox，risk=high", async () => {
    const graph = buildNpmGraph({ 'js-toolb0x': '1.0.0' });
    const findings = await detector.detect(graph);

    expect(findings).toHaveLength(1);
    expect(findings[0].risk).toBe('high');
    expect(findings[0].signals.nameSimilarity?.target).toBe('js-toolbox');
    expect(findings[0].signals.behaviorFlags).toContain('name-contains-digit');
  });

  it("合法知名包 lodash / express 不被标记", async () => {
    const graph = buildNpmGraph({ lodash: '4.17.21', express: '4.18.2' });
    const findings = await detector.detect(graph);

    expect(findings).toHaveLength(0);
  });

  it('evidence 非空且可解释（含包名 / 目标 / 编辑距离 / 分数）', async () => {
    const graph = buildNpmGraph({ lodahs: '1.0.0' });
    const findings = await detector.detect(graph);

    expect(findings[0].evidence.length).toBeGreaterThan(0);
    for (const line of findings[0].evidence) {
      expect(line).toContain('lodahs');
      expect(line).toContain('lodash');
    }
    expect(findings[0].evidence[0]).toMatch(EDIT_DISTANCE_RE);
    expect(findings[0].evidence[0]).toMatch(SCORE_RE);
  });

  it('视觉混淆与数字 / 连字符行为标记均在证据中体现', async () => {
    const graph = buildNpmGraph({ 'js-toolb0x': '1.0.0' });
    const findings = await detector.detect(graph);

    expect(findings[0].evidence.some((l) => l.includes('visually resembles'))).toBe(true);
    expect(findings[0].evidence.some((l) => l.includes('behavior flag: name-contains-digit'))).toBe(true);
  });

  it("'lodash-2' → 版本后缀冒名：risk=medium，行为标记齐全", async () => {
    const graph = buildNpmGraph({ 'lodash-2': '1.0.0' });
    const findings = await detector.detect(graph);

    expect(findings).toHaveLength(1);
    expect(findings[0].risk).toBe('medium');
    expect(findings[0].signals.behaviorFlags).toEqual(
      expect.arrayContaining(['name-contains-digit', 'name-contains-hyphen', 'known-name-version-suffix']),
    );
  });

  it('超长数字后缀包名快速处理，不触发 ReDoS 挂起', { timeout: 1000 }, async () => {
    const graph = buildNpmGraph({ [`lodash-${'9'.repeat(5000)}`]: '1.0.0' });
    const findings = await detector.detect(graph);
    // 编辑距离远超阈值 → 无命中；关键断言是快速返回且不抛异常
    expect(findings).toEqual([]);
  });

  it('空图谱 → 空数组，不抛异常', async () => {
    const dir = tmpDir('zh-dep-typosquat-empty-');
    const graph = buildDependencyGraph(dir);

    await expect(detector.detect(graph)).resolves.toEqual([]);
  });

  it('结果按风险降序排列：high 在 medium 之前', async () => {
    const graph = buildNpmGraph({
      lodahs: '1.0.0', // high（编辑距离 1）
      'lodash-2': '1.0.0', // medium（编辑距离 2）
    });
    const findings = await detector.detect(graph);

    expect(findings.map((f) => f.risk)).toEqual(['high', 'medium']);
    expect(findings[0].nodeId).toBe('lodahs@1.0.0');
  });
});
