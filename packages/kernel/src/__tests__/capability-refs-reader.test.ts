import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  getReclaimingToolRuleIds,
  getReclaimingToolRuleSinces,
  getReclaimingSopModuleIds,
  getReclaimingSopModuleSinces,
} from '../sop/sync/capability-refs-reader';

describe('getReclaimingToolRuleIds', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-caprefs-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLedger(ledger: unknown): void {
    fs.writeFileSync(path.join(tmpDir, 'capability-refs.json'), JSON.stringify(ledger), 'utf-8');
  }

  it('collects all reclaiming toolrule ids', () => {
    writeLedger({
      schemaVersion: 1,
      capabilities: {
        'toolrule:eslint': { languages: [], refs: [], status: 'reclaiming', since: 1759747200000 },
        'toolrule:trivy': { languages: [], refs: [], status: 'reclaiming', since: 1759747200000 },
      },
    });
    expect(getReclaimingToolRuleIds(tmpDir)).toEqual(new Set(['eslint', 'trivy']));
  });

  it('ignores active (non-reclaiming) capabilities', () => {
    writeLedger({
      schemaVersion: 1,
      capabilities: {
        'toolrule:eslint': { languages: [], refs: [], status: 'active', since: 1759747200000 },
        'toolrule:semgrep': { languages: [], refs: [], status: 'reclaiming', since: 1759747200000 },
      },
    });
    expect(getReclaimingToolRuleIds(tmpDir)).toEqual(new Set(['semgrep']));
  });

  it('only collects toolrule: prefixed keys, ignoring sop-module:', () => {
    writeLedger({
      schemaVersion: 1,
      capabilities: {
        'toolrule:eslint': { languages: [], refs: [], status: 'reclaiming', since: 1759747200000 },
        'sop-module:guard': { languages: [], refs: [], status: 'reclaiming', since: 1759747200000 },
      },
    });
    expect(getReclaimingToolRuleIds(tmpDir)).toEqual(new Set(['eslint']));
  });

  it('returns empty set for corrupted JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'capability-refs.json'), '{ not valid json', 'utf-8');
    expect(getReclaimingToolRuleIds(tmpDir)).toEqual(new Set());
  });

  it('returns empty set when file is missing', () => {
    expect(getReclaimingToolRuleIds(tmpDir)).toEqual(new Set());
  });
});

describe('getReclaimingToolRuleSinces', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-caprefs-sinces-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLedger(ledger: unknown): void {
    fs.writeFileSync(path.join(tmpDir, 'capability-refs.json'), JSON.stringify(ledger), 'utf-8');
  }

  it('reclaiming 且 since 存在 → 返回 toolId → since 映射', () => {
    writeLedger({
      schemaVersion: 1,
      capabilities: {
        'toolrule:eslint': { languages: [], refs: [], status: 'reclaiming', since: 1759747200000 },
        'toolrule:trivy': { languages: [], refs: [], status: 'reclaiming', since: 1759747200001 },
      },
    });
    expect(getReclaimingToolRuleSinces(tmpDir)).toEqual(
      new Map([
        ['eslint', 1759747200000],
        ['trivy', 1759747200001],
      ]),
    );
  });

  it('since 缺失 → 排除（保守方向，宁留不删）', () => {
    writeLedger({
      schemaVersion: 1,
      capabilities: {
        'toolrule:eslint': { languages: [], refs: [], status: 'reclaiming' },
      },
    });
    expect(getReclaimingToolRuleSinces(tmpDir)).toEqual(new Map());
  });

  it('since 非法（字符串/负数/null）→ 排除', () => {
    writeLedger({
      schemaVersion: 1,
      capabilities: {
        'toolrule:eslint': { languages: [], refs: [], status: 'reclaiming', since: '1759747200000' },
        'toolrule:trivy': { languages: [], refs: [], status: 'reclaiming', since: -5 },
        'toolrule:semgrep': { languages: [], refs: [], status: 'reclaiming', since: null },
      },
    });
    expect(getReclaimingToolRuleSinces(tmpDir)).toEqual(new Map());
  });

  it('active（非 reclaiming）→ 排除', () => {
    writeLedger({
      schemaVersion: 1,
      capabilities: {
        'toolrule:eslint': { languages: [], refs: [], status: 'active', since: 1759747200000 },
      },
    });
    expect(getReclaimingToolRuleSinces(tmpDir)).toEqual(new Map());
  });

  it('文件缺失 → 空 Map', () => {
    expect(getReclaimingToolRuleSinces(tmpDir)).toEqual(new Map());
  });

  it('JSON 损坏 → 空 Map', () => {
    fs.writeFileSync(path.join(tmpDir, 'capability-refs.json'), '{ not valid json', 'utf-8');
    expect(getReclaimingToolRuleSinces(tmpDir)).toEqual(new Map());
  });
});

describe('getReclaimingSopModuleIds', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-caprefs-sop-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLedger(ledger: unknown): void {
    fs.writeFileSync(path.join(tmpDir, 'capability-refs.json'), JSON.stringify(ledger), 'utf-8');
  }

  it('collects all reclaiming sop-module ids', () => {
    writeLedger({
      schemaVersion: 1,
      capabilities: {
        'sop-module:typescript': { languages: [], refs: [], status: 'reclaiming', since: 1759747200000 },
        'sop-module:nestjs': { languages: [], refs: [], status: 'reclaiming', since: 1759747200000 },
      },
    });
    expect(getReclaimingSopModuleIds(tmpDir)).toEqual(new Set(['typescript', 'nestjs']));
  });

  it('ignores active (non-reclaiming) sop-module capabilities', () => {
    writeLedger({
      schemaVersion: 1,
      capabilities: {
        'sop-module:typescript': { languages: [], refs: [], status: 'active', since: 1759747200000 },
        'sop-module:quality': { languages: [], refs: [], status: 'reclaiming', since: 1759747200000 },
      },
    });
    expect(getReclaimingSopModuleIds(tmpDir)).toEqual(new Set(['quality']));
  });

  it('only collects sop-module: prefixed keys, ignoring toolrule:', () => {
    writeLedger({
      schemaVersion: 1,
      capabilities: {
        'sop-module:typescript': { languages: [], refs: [], status: 'reclaiming', since: 1759747200000 },
        'toolrule:eslint': { languages: [], refs: [], status: 'reclaiming', since: 1759747200000 },
      },
    });
    expect(getReclaimingSopModuleIds(tmpDir)).toEqual(new Set(['typescript']));
  });

  it('returns empty set for corrupted JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'capability-refs.json'), '{ not valid json', 'utf-8');
    expect(getReclaimingSopModuleIds(tmpDir)).toEqual(new Set());
  });

  it('returns empty set when file is missing', () => {
    expect(getReclaimingSopModuleIds(tmpDir)).toEqual(new Set());
  });
});

describe('getReclaimingSopModuleSinces', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-caprefs-sop-sinces-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLedger(ledger: unknown): void {
    fs.writeFileSync(path.join(tmpDir, 'capability-refs.json'), JSON.stringify(ledger), 'utf-8');
  }

  it('reclaiming 且 since 存在 → 返回 module → since 映射', () => {
    writeLedger({
      schemaVersion: 1,
      capabilities: {
        'sop-module:typescript': { languages: [], refs: [], status: 'reclaiming', since: 1759747200000 },
        'sop-module:nestjs': { languages: [], refs: [], status: 'reclaiming', since: 1759747200001 },
      },
    });
    expect(getReclaimingSopModuleSinces(tmpDir)).toEqual(
      new Map([
        ['typescript', 1759747200000],
        ['nestjs', 1759747200001],
      ]),
    );
  });

  it('since 缺失 → 排除（保守方向，宁留不删）', () => {
    writeLedger({
      schemaVersion: 1,
      capabilities: {
        'sop-module:typescript': { languages: [], refs: [], status: 'reclaiming' },
      },
    });
    expect(getReclaimingSopModuleSinces(tmpDir)).toEqual(new Map());
  });

  it('since 非法（字符串/负数/null）→ 排除', () => {
    writeLedger({
      schemaVersion: 1,
      capabilities: {
        'sop-module:typescript': { languages: [], refs: [], status: 'reclaiming', since: '1759747200000' },
        'sop-module:nestjs': { languages: [], refs: [], status: 'reclaiming', since: -5 },
        'sop-module:quality': { languages: [], refs: [], status: 'reclaiming', since: null },
      },
    });
    expect(getReclaimingSopModuleSinces(tmpDir)).toEqual(new Map());
  });

  it('active（非 reclaiming）→ 排除', () => {
    writeLedger({
      schemaVersion: 1,
      capabilities: {
        'sop-module:typescript': { languages: [], refs: [], status: 'active', since: 1759747200000 },
      },
    });
    expect(getReclaimingSopModuleSinces(tmpDir)).toEqual(new Map());
  });

  it('toolrule 键不串扰 → 仅收集 sop-module', () => {
    writeLedger({
      schemaVersion: 1,
      capabilities: {
        'toolrule:eslint': { languages: [], refs: [], status: 'reclaiming', since: 1759747200000 },
        'sop-module:typescript': { languages: [], refs: [], status: 'reclaiming', since: 1759747200000 },
      },
    });
    expect(getReclaimingSopModuleSinces(tmpDir)).toEqual(new Map([['typescript', 1759747200000]]));
  });

  it('文件缺失 → 空 Map', () => {
    expect(getReclaimingSopModuleSinces(tmpDir)).toEqual(new Map());
  });

  it('JSON 损坏 → 空 Map', () => {
    fs.writeFileSync(path.join(tmpDir, 'capability-refs.json'), '{ not valid json', 'utf-8');
    expect(getReclaimingSopModuleSinces(tmpDir)).toEqual(new Map());
  });
});