import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WhitelistManager } from '../whitelist-manager';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whitelist-test-'));
}

describe('WhitelistManager', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('should add and list entries', async () => {
    const manager = new WhitelistManager(tmpDir);
    const entry = await manager.add({
      projectId: 'proj-1', scope: 'project', target: '', ruleId: 'RULE-001',
      reason: 'False positive', operator: 'admin',
    });
    expect(entry.id).toBeDefined();
    expect(entry.ruleId).toBe('RULE-001');
    expect(manager.list()).toHaveLength(1);
  });

  it('should remove an entry', async () => {
    const manager = new WhitelistManager(tmpDir);
    const entry = await manager.add({
      projectId: 'proj-1', scope: 'project', target: '', ruleId: 'RULE-001',
      reason: 'test', operator: 'admin',
    });
    const removed = await manager.remove(entry.id);
    expect(removed).toBe(true);
    expect(manager.list()).toHaveLength(0);
  });

  it('should return false when removing non-existent entry', async () => {
    const manager = new WhitelistManager(tmpDir);
    const removed = await manager.remove('nonexistent');
    expect(removed).toBe(false);
  });

  it('should check project-scope whitelist', async () => {
    const manager = new WhitelistManager(tmpDir);
    await manager.add({
      projectId: 'proj-1', scope: 'project', target: '', ruleId: 'RULE-001',
      reason: 'test', operator: 'admin',
    });
    const result = manager.isWhitelisted('RULE-001', 'src/app.ts');
    expect(result.whitelisted).toBe(true);
    expect(result.entry).toBeDefined();
  });

  it('should check file-scope whitelist', async () => {
    const manager = new WhitelistManager(tmpDir);
    await manager.add({
      projectId: 'proj-1', scope: 'file', target: 'src/config.ts', ruleId: '*',
      reason: 'test', operator: 'admin',
    });
    const result = manager.isWhitelisted('RULE-001', 'src/config.ts');
    expect(result.whitelisted).toBe(true);
  });

  it('should check rule-scope whitelist', async () => {
    const manager = new WhitelistManager(tmpDir);
    await manager.add({
      projectId: 'proj-1', scope: 'rule', target: 'src/test/', ruleId: 'RULE-001',
      reason: 'test', operator: 'admin',
    });
    const result = manager.isWhitelisted('RULE-001', 'src/test/file.ts');
    expect(result.whitelisted).toBe(true);
  });

  it('should not whitelist when rule does not match', async () => {
    const manager = new WhitelistManager(tmpDir);
    await manager.add({
      projectId: 'proj-1', scope: 'project', target: '', ruleId: 'RULE-001',
      reason: 'test', operator: 'admin',
    });
    const result = manager.isWhitelisted('RULE-999', 'src/app.ts');
    expect(result.whitelisted).toBe(false);
  });

  it('should filter list by projectId', async () => {
    const manager = new WhitelistManager(tmpDir);
    await manager.add({ projectId: 'proj-1', scope: 'project', target: '', ruleId: 'R1', reason: 't', operator: 'a' });
    await manager.add({ projectId: 'proj-2', scope: 'project', target: '', ruleId: 'R2', reason: 't', operator: 'a' });
    expect(manager.list('proj-1')).toHaveLength(1);
    expect(manager.list('proj-2')).toHaveLength(1);
    expect(manager.list()).toHaveLength(2);
  });

  it('should persist to yaml file', async () => {
    const manager = new WhitelistManager(tmpDir);
    await manager.add({ projectId: 'proj-1', scope: 'project', target: '', ruleId: 'RULE-001', reason: 'Persistent entry', operator: 'admin' });
    const yamlPath = path.join(tmpDir, '.zhshield', 'whitelist.yml');
    expect(fs.existsSync(yamlPath)).toBe(true);
    const content = fs.readFileSync(yamlPath, 'utf-8');
    expect(content).toContain('RULE-001');
  });

  it('should load from existing yaml file', async () => {
    const configDir = path.join(tmpDir, '.zhshield');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'whitelist.yml'), 'whitelist:\n  project:\n    - rule: "RULE-100"\n      reason: "loaded from file"\n');
    const manager = new WhitelistManager(tmpDir);
    await manager.load();
    const entries = manager.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].ruleId).toBe('RULE-100');
  });

  it('should not whitelist expired entries', async () => {
    const manager = new WhitelistManager(tmpDir);
    await manager.add({ projectId: 'p1', scope: 'project', target: '', ruleId: 'R1', reason: 'exp', operator: 'a', expiresAt: '2020-01-01T00:00:00Z' });
    const result = manager.isWhitelisted('R1', 'src/app.ts');
    expect(result.whitelisted).toBe(false);
  });

  it('should list expired entries', async () => {
    const manager = new WhitelistManager(tmpDir);
    await manager.add({ projectId: 'p1', scope: 'project', target: '', ruleId: 'R1', reason: 'exp', operator: 'a', expiresAt: '2020-01-01T00:00:00Z' });
    await manager.add({ projectId: 'p1', scope: 'project', target: '', ruleId: 'R2', reason: 'ok', operator: 'a', expiresAt: '2030-01-01T00:00:00Z' });
    const expired = manager.getExpired();
    expect(expired).toHaveLength(1);
    expect(expired[0].ruleId).toBe('R1');
  });
});
