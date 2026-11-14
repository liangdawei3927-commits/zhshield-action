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

  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should add and list entries', async () => {
    const manager = new WhitelistManager(tmpDir);
    const entry = await manager.add({
      projectId: 'proj-1',
      scope: 'project',
      target: '',
      ruleId: 'RULE-001',
      reason: 'False positive',
      operator: 'admin',
    });
    expect(entry.id).toBeDefined();
    expect(entry.ruleId).toBe('RULE-001');
    expect(manager.list()).toHaveLength(1);
  });

  it('should remove an entry', async () => {
    const manager = new WhitelistManager(tmpDir);
    const entry = await manager.add({
      projectId: 'proj-1',
      scope: 'project',
      target: '',
      ruleId: 'RULE-001',
      reason: 'test',
      operator: 'admin',
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
      projectId: 'proj-1',
      scope: 'project',
      target: '',
      ruleId: 'RULE-001',
      reason: 'test',
      operator: 'admin',
    });
    const result = manager.isWhitelisted('RULE-001', 'src/app.ts');
    expect(result.whitelisted).toBe(true);
    expect(result.entry).toBeDefined();
  });

  /**
   * 项目级豁免必须命中「规则身份 + 实例后缀」形态的 id。
   *
   * 真实形态：安全域 check-list 的违规 id 是 `ruleId:file:line`，配置类检查
   * （KMS / 密钥轮换 / 安全头）file 为空，于是落成 `...key-rotation::0`。
   * 旧实现要求全等，用户写稳定的规则 id 永远不命中，且行号一变豁免就失效。
   */
  it('项目级白名单按规则身份命中带实例后缀的 id', async () => {
    const manager = new WhitelistManager(tmpDir);
    await manager.add({
      projectId: 'proj-1',
      scope: 'project',
      target: '',
      ruleId: 'security.scan.internal.key-rotation',
      reason: '本项目不接入 KMS，接受风险',
      operator: 'dawei',
    });
    expect(
      manager.isWhitelisted('security.scan.internal.key-rotation::0', '').whitelisted,
    ).toBe(true);
    // 相似前缀不得误命中：`-v2` 是另一条规则
    expect(
      manager.isWhitelisted('security.scan.internal.key-rotation-v2::0', '').whitelisted,
    ).toBe(false);
  });

  /**
   * 理由必填：空理由的条目不是「接受风险」，是「关掉报警」。
   *
   * 两者在配置文件里只差一个字符串，机器分不出动机，所以只挡「完全没写」。
   * 只读侧跳过而非报错：解析失败会让整份白名单失效，把用户已确认的误报
   * 全变回问题；跳过只影响没写理由的那几条，恰好是该暴露的部分。
   */
  describe('理由必填', () => {
    const writeYaml = (reasonLine: string): void => {
      const dir = path.join(tmpDir, '.zhshield');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'whitelist.yml'),
        ['whitelist:', '  project:', '    - rule: "RULE-001"', reasonLine].join('\n'),
      );
    };

    it('空白理由的条目加载后不生效', async () => {
      writeYaml('      reason: "   "');
      const manager = new WhitelistManager(tmpDir);
      await manager.load();
      expect(manager.isWhitelisted('RULE-001', 'src/app.ts').whitelisted).toBe(false);
      // 条目本身仍被加载（不是丢弃）：用户能看到它存在，才知道要补理由
      expect(manager.list()).toHaveLength(1);
    });

    it('缺 reason 键的条目加载后不生效', async () => {
      const dir = path.join(tmpDir, '.zhshield');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'whitelist.yml'),
        ['whitelist:', '  project:', '    - rule: "RULE-001"'].join('\n'),
      );
      const manager = new WhitelistManager(tmpDir);
      await manager.load();
      expect(manager.isWhitelisted('RULE-001', 'src/app.ts').whitelisted).toBe(false);
    });

    it('写了理由的条目照常生效（不误伤）', async () => {
      writeYaml('      reason: "已核验为误报"');
      const manager = new WhitelistManager(tmpDir);
      await manager.load();
      expect(manager.isWhitelisted('RULE-001', 'src/app.ts').whitelisted).toBe(true);
    });

    it('add() 拒绝空理由，避免写入永不生效的条目', async () => {
      const manager = new WhitelistManager(tmpDir);
      await expect(
        manager.add({
          projectId: 'p1',
          scope: 'project',
          target: '',
          ruleId: 'R1',
          reason: '  ',
          operator: 'a',
        }),
      ).rejects.toThrow(/必须填写理由/);
      expect(manager.list()).toHaveLength(0);
    });
  });

  it('should check file-scope whitelist', async () => {
    const manager = new WhitelistManager(tmpDir);
    await manager.add({
      projectId: 'proj-1',
      scope: 'file',
      target: 'src/config.ts',
      ruleId: '*',
      reason: 'test',
      operator: 'admin',
    });
    const result = manager.isWhitelisted('RULE-001', 'src/config.ts');
    expect(result.whitelisted).toBe(true);
  });

  it('should check rule-scope whitelist', async () => {
    const manager = new WhitelistManager(tmpDir);
    await manager.add({
      projectId: 'proj-1',
      scope: 'rule',
      target: 'src/test/',
      ruleId: 'RULE-001',
      reason: 'test',
      operator: 'admin',
    });
    const result = manager.isWhitelisted('RULE-001', 'src/test/file.ts');
    expect(result.whitelisted).toBe(true);
  });

  it('should not whitelist when rule does not match', async () => {
    const manager = new WhitelistManager(tmpDir);
    await manager.add({
      projectId: 'proj-1',
      scope: 'project',
      target: '',
      ruleId: 'RULE-001',
      reason: 'test',
      operator: 'admin',
    });
    const result = manager.isWhitelisted('RULE-999', 'src/app.ts');
    expect(result.whitelisted).toBe(false);
  });

  it('should filter list by projectId', async () => {
    const manager = new WhitelistManager(tmpDir);
    await manager.add({
      projectId: 'proj-1',
      scope: 'project',
      target: '',
      ruleId: 'R1',
      reason: 't',
      operator: 'a',
    });
    await manager.add({
      projectId: 'proj-2',
      scope: 'project',
      target: '',
      ruleId: 'R2',
      reason: 't',
      operator: 'a',
    });
    expect(manager.list('proj-1')).toHaveLength(1);
    expect(manager.list('proj-2')).toHaveLength(1);
    expect(manager.list()).toHaveLength(2);
  });

  it('should persist to yaml file', async () => {
    const manager = new WhitelistManager(tmpDir);
    await manager.add({
      projectId: 'proj-1',
      scope: 'project',
      target: '',
      ruleId: 'RULE-001',
      reason: 'Persistent entry',
      operator: 'admin',
    });
    const yamlPath = path.join(tmpDir, '.zhshield', 'whitelist.yml');
    expect(fs.existsSync(yamlPath)).toBe(true);
    const content = fs.readFileSync(yamlPath, 'utf-8');
    expect(content).toContain('RULE-001');
  });

  it('should load from existing yaml file', async () => {
    const configDir = path.join(tmpDir, '.zhshield');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'whitelist.yml'),
      'whitelist:\n  project:\n    - rule: "RULE-100"\n      reason: "loaded from file"\n',
    );
    const manager = new WhitelistManager(tmpDir);
    await manager.load();
    const entries = manager.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].ruleId).toBe('RULE-100');
  });

  it('should not whitelist expired entries', async () => {
    const manager = new WhitelistManager(tmpDir);
    await manager.add({
      projectId: 'p1',
      scope: 'project',
      target: '',
      ruleId: 'R1',
      reason: 'exp',
      operator: 'a',
      expiresAt: '2020-01-01T00:00:00Z',
    });
    const result = manager.isWhitelisted('R1', 'src/app.ts');
    expect(result.whitelisted).toBe(false);
  });

  it('should list expired entries', async () => {
    const manager = new WhitelistManager(tmpDir);
    await manager.add({
      projectId: 'p1',
      scope: 'project',
      target: '',
      ruleId: 'R1',
      reason: 'exp',
      operator: 'a',
      expiresAt: '2020-01-01T00:00:00Z',
    });
    await manager.add({
      projectId: 'p1',
      scope: 'project',
      target: '',
      ruleId: 'R2',
      reason: 'ok',
      operator: 'a',
      expiresAt: '2030-01-01T00:00:00Z',
    });
    const expired = manager.getExpired();
    expect(expired).toHaveLength(1);
    expect(expired[0].ruleId).toBe('R1');
  });
});
