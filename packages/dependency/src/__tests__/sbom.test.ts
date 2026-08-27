import { describe, expect, it } from 'vitest';
import type { DependencyGraph } from '../types';
import { toCycloneDX } from '../sbom';
import { ROOT_NODE_ID, ROOT_NODE_NAME } from '../types';

const UUID_URN_RE = /^urn:uuid:/;

/** 构造一个含许可 / 完整性 / 未知许可节点的示例图谱 */
function sampleGraph(): DependencyGraph {
  return {
    schemaVersion: 1,
    targetId: 'demo',
    ecosystem: 'npm',
    nodes: [
      {
        id: 'lodash@4.17.21',
        name: 'lodash',
        version: '4.17.21',
        declaredRange: '^4.17.21',
        kind: 'direct',
        integrity: 'sha512-abc123',
        trust: 'verified',
        vulnerabilities: [],
        license: 'MIT',
      },
      {
        id: 'express@4.19.2',
        name: 'express',
        version: '4.19.2',
        declaredRange: '^4.19.2',
        kind: 'direct',
        trust: 'unknown',
        vulnerabilities: [],
        license: '(Apache-2.0)',
      },
      {
        id: 'ms@2.1.3',
        name: 'ms',
        version: '2.1.3',
        declaredRange: '',
        kind: 'transitive',
        trust: 'unknown',
        vulnerabilities: [],
      },
    ],
    edges: [
      { from: ROOT_NODE_ID, to: 'lodash@4.17.21', requirement: '^4.17.21' },
      { from: ROOT_NODE_ID, to: 'express@4.19.2', requirement: '^4.19.2' },
    ],
    lockfile: { present: true, consistent: true, integrityVerified: false },
    generatedAt: new Date().toISOString(),
  };
}

describe('toCycloneDX', () => {
  it('输出 CycloneDX 1.5 文档骨架', () => {
    const doc = toCycloneDX(sampleGraph());

    expect(doc.bomFormat).toBe('CycloneDX');
    expect(doc.specVersion).toBe('1.5');
    expect(doc.serialNumber).toMatch(UUID_URN_RE);
    expect(doc.version).toBe(1);
    expect(doc.metadata.component).toEqual({ type: 'application', name: ROOT_NODE_NAME });
    expect(() => new Date(doc.metadata.timestamp)).not.toThrow();
  });

  it('组件映射：bom-ref / name / version / licenses / hashes', () => {
    const doc = toCycloneDX(sampleGraph());

    expect(doc.components).toHaveLength(3);

    const lodash = doc.components.find((c) => c.name === 'lodash');
    expect(lodash?.['bom-ref']).toBe('lodash@4.17.21');
    expect(lodash?.version).toBe('4.17.21');
    expect(lodash?.type).toBe('library');
    expect(lodash?.licenses).toEqual([{ license: { id: 'MIT' } }]);
    expect(lodash?.hashes).toEqual([{ alg: 'SHA-512', content: 'abc123' }]);

    const express = doc.components.find((c) => c.name === 'express');
    expect(express?.licenses).toEqual([{ license: { id: 'Apache-2.0' } }]);
    expect(express?.hashes).toBeUndefined();

    const ms = doc.components.find((c) => c.name === 'ms');
    expect(ms?.licenses).toBeUndefined();
    expect(ms?.hashes).toBeUndefined();
  });

  it('依赖关系：根指向直接依赖，传递节点 dependsOn 为空', () => {
    const doc = toCycloneDX(sampleGraph());

    const root = doc.dependencies.find((d) => d.ref === ROOT_NODE_ID);
    expect(root?.dependsOn).toHaveLength(2);
    expect(root?.dependsOn).toContain('lodash@4.17.21');
    expect(root?.dependsOn).toContain('express@4.19.2');

    for (const dep of doc.dependencies) {
      if (dep.ref === ROOT_NODE_ID) continue;
      expect(dep.dependsOn).toEqual([]);
    }

    const refs = doc.dependencies.map((d) => d.ref);
    expect(refs).toContain('ms@2.1.3');
  });

  it('无法识别的许可证不输出 licenses', () => {
    const graph = sampleGraph();
    graph.nodes[2] = {
      ...graph.nodes[2],
      license: 'Some-Weird-License',
    };

    const doc = toCycloneDX(graph);

    const ms = doc.components.find((c) => c.name === 'ms');
    expect(ms?.licenses).toBeUndefined();
  });

  it('非 sha512 完整性不输出 hashes', () => {
    const graph = sampleGraph();
    graph.nodes[0] = {
      ...graph.nodes[0],
      integrity: 'sha256-other-hash',
    };

    const doc = toCycloneDX(graph);

    const lodash = doc.components.find((c) => c.name === 'lodash');
    expect(lodash?.hashes).toBeUndefined();
  });
});
