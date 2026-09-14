import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveBundledSopDir } from '../sop-dir';

const DOMAIN_DIRS = ['guard', 'inspect', 'security', 'sentinel', 'evolve'];

describe('resolveBundledSopDir', () => {
  it('sop/presets/sop-templates 存在时优先返回该子目录', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-sop-templates-'));
    const templates = path.join(base, 'sop', 'presets', 'sop-templates');
    fs.mkdirSync(path.join(templates, 'guard'), { recursive: true });
    expect(resolveBundledSopDir(base)).toBe(templates);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('旧布局（域目录位于 sop/ 一级）时回退到 sop/ 本身', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-sop-legacy-'));
    const sop = path.join(base, 'sop');
    fs.mkdirSync(path.join(sop, 'guard'), { recursive: true });
    expect(resolveBundledSopDir(base)).toBe(sop);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('sop 存在但无域目录时返回 undefined（回退 PipelineRunner 默认路径）', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-sop-empty-'));
    fs.mkdirSync(path.join(base, 'sop'), { recursive: true });
    expect(resolveBundledSopDir(base)).toBeUndefined();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('无 bundled sop 目录时返回 undefined', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-sop-none-'));
    expect(resolveBundledSopDir(base)).toBeUndefined();
    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe.skipIf(!fs.existsSync(path.resolve(__dirname, '..', '..', 'dist', 'sop')))(
  'resolveBundledSopDir — dist 构建产物',
  () => {
    it('返回存在的目录且域目录（guard/inspect/security/sentinel/evolve）直接位于其下', () => {
      const sopDir = resolveBundledSopDir(path.resolve(__dirname, '..', '..', 'dist'));
      expect(sopDir).toBeDefined();
      for (const domain of DOMAIN_DIRS) {
        expect(fs.existsSync(path.join(sopDir!, domain))).toBe(true);
      }
    });
  },
);