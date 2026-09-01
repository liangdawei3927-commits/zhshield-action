import { describe, expect, it } from 'vitest';
import { translate, DEFAULT_LANGUAGE } from '@zh/i18n';
import type { DependencyGraph, DependencyNode } from '../types';
import { ROOT_NODE_ID } from '../types';
import { buildLicenseMatrix, classifyLicense, normalizeLicenseId } from '../license-matrix';

/** 构造仅含指定许可证节点的图谱 */
function graphWithLicenses(
  entries: Array<{ name: string; version: string; license?: string }>,
): DependencyGraph {
  const nodes: DependencyNode[] = entries.map((entry) => {
    const node: DependencyNode = {
      id: `${entry.name}@${entry.version}`,
      name: entry.name,
      version: entry.version,
      declaredRange: '',
      kind: 'transitive',
      trust: 'unknown',
      vulnerabilities: [],
    };
    if (entry.license !== undefined) node.license = entry.license;
    return node;
  });
  return {
    schemaVersion: 1,
    targetId: 'demo',
    ecosystem: 'npm',
    nodes,
    edges: [],
    lockfile: { present: true, consistent: true, integrityVerified: false },
    generatedAt: new Date().toISOString(),
  };
}

describe('buildLicenseMatrix', () => {
  it('MIT + GPL-3.0 + 未知许可 → 分类计数正确', () => {
    const graph = graphWithLicenses([
      { name: 'lodash', version: '4.17.21', license: 'MIT' },
      { name: 'bash', version: '2.0.0', license: 'GPL-3.0' },
      { name: 'opaque', version: '1.0.0' },
    ]);

    const report = buildLicenseMatrix(graph);

    expect(report.total).toBe(3);
    expect(report.byCategory).toEqual({
      permissive: 1,
      'weak-copyleft': 0,
      'strong-copyleft': 1,
      unknown: 1,
    });

    const bash = report.entries.find((e) => e.name === 'bash');
    expect(bash?.category).toBe('strong-copyleft');
    expect(bash?.risk).toBe('high');

    const opaque = report.entries.find((e) => e.name === 'opaque');
    expect(opaque?.category).toBe('unknown');
    expect(opaque?.risk).toBe('medium');
    expect(opaque?.reason).toBe(
      translate('engine.dependency.license.unknownReason', DEFAULT_LANGUAGE),
    );

    const lodash = report.entries.find((e) => e.name === 'lodash');
    expect(lodash?.category).toBe('permissive');
    expect(lodash?.risk).toBe('low');
  });

  it('弱左版许可 → weak-copyleft / medium 风险', () => {
    const graph = graphWithLicenses([
      { name: 'a', version: '1.0.0', license: 'LGPL-3.0' },
      { name: 'b', version: '1.0.0', license: 'MPL-2.0' },
      { name: 'c', version: '1.0.0', license: 'LGPL-2.1' },
    ]);

    const report = buildLicenseMatrix(graph);

    expect(report.byCategory['weak-copyleft']).toBe(3);
    for (const entry of report.entries) {
      expect(entry.risk).toBe('medium');
    }
  });

  it('识别大小写 / 格式差异并归类为宽松许可', () => {
    const graph = graphWithLicenses([
      { name: 'a', version: '1.0.0', license: 'apache 2.0' },
      { name: 'b', version: '1.0.0', license: '(MIT)' },
      { name: 'c', version: '1.0.0', license: 'BSD-3-Clause' },
      { name: 'd', version: '1.0.0', license: 'ISC' },
    ]);

    const report = buildLicenseMatrix(graph);

    expect(report.byCategory.permissive).toBe(4);
    for (const entry of report.entries) {
      expect(entry.risk).toBe('low');
    }
  });

  it('忽略图谱根节点（<root>）', () => {
    const graph = graphWithLicenses([{ name: 'x', version: '1.0.0', license: 'MIT' }]);
    graph.nodes.push({
      id: ROOT_NODE_ID,
      name: '<root>',
      version: '',
      declaredRange: '',
      kind: 'direct',
      trust: 'unknown',
      vulnerabilities: [],
    });

    const report = buildLicenseMatrix(graph);

    expect(report.total).toBe(1);
    expect(report.entries[0]?.name).toBe('x');
  });
});

describe('normalizeLicenseId', () => {
  it('大小写与连字符归一', () => {
    expect(normalizeLicenseId('mit')).toBe('MIT');
    expect(normalizeLicenseId('Apache 2.0')).toBe('Apache-2.0');
    expect(normalizeLicenseId('Apache-2')).toBe('Apache-2.0');
    expect(normalizeLicenseId('apache2')).toBe('Apache-2.0');
    expect(normalizeLicenseId('gplv3')).toBe('GPL-3.0');
    expect(normalizeLicenseId('AGPL-3.0-only')).toBe('AGPL-3.0');
  });

  it('外围括号剥离', () => {
    expect(normalizeLicenseId('(MIT)')).toBe('MIT');
    expect(normalizeLicenseId('((Apache-2.0))')).toBe('Apache-2.0');
  });

  it('OR 表达式取更严格许可', () => {
    expect(normalizeLicenseId('MIT OR Apache-2.0')).toBe('Apache-2.0');
    expect(normalizeLicenseId('MIT OR GPL-3.0')).toBe('GPL-3.0');
    expect(normalizeLicenseId('LGPL-3.0 OR MIT')).toBe('LGPL-3.0');
  });

  it('无法识别或空值返回 null', () => {
    expect(normalizeLicenseId('')).toBeNull();
    expect(normalizeLicenseId('Totally-Made-Up')).toBeNull();
    expect(normalizeLicenseId('MIT AND Apache-2.0')).toBeNull();
  });
});

describe('classifyLicense', () => {
  it('宽松许可清单', () => {
    for (const id of [
      'MIT',
      'Apache-2.0',
      'BSD-2-Clause',
      'BSD-3-Clause',
      'ISC',
      '0BSD',
      'Unlicense',
      'MIT-0',
      'PostgreSQL',
      'Python-2.0',
      'Zlib',
    ]) {
      expect(classifyLicense(id)).toBe('permissive');
    }
  });

  it('缺失 / 未知许可 → unknown', () => {
    expect(classifyLicense(undefined)).toBe('unknown');
    expect(classifyLicense('')).toBe('unknown');
    expect(classifyLicense('Commons Clause')).toBe('unknown');
  });
});
