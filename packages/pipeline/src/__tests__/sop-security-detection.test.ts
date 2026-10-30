import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SopRuleEngine, SopRegistry, SopLoader } from '@zh/kernel';
import { SemgrepAdapter } from '@zh/inspect';

/**
 * 安全域 SAST 规则检出回归（2026-10-30）
 *
 * 背景：SOP 模板里的 command-injection / sql-injection / xss 三条规则在埋雷项目上
 * 全部报「检查通过、0 issues」，但样本里 `exec('ls ' + userInput)`、
 * `db.query('SELECT ...' + name)`、`el.innerHTML = comment` 都真实存在。
 * 两处根因：
 *   ① 内联规则未声明语言时默认 languages: [typescript]，.js 文件整类不参与扫描；
 *   ② 规则 pattern 形状与真实调用不符（exec($VAR) 匹配不到带回调的两参数调用）。
 * 本文件用真实 semgrep 在临时项目上回放，任何一条检不出即红 —— 防止再退回「假通过」。
 *
 * 环境无 semgrep 时跳过：工具可用性由适配器自身判定，不在测试里伪造命中。
 */
const TEMPLATES_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'kernel',
  'src',
  'sop',
  'presets',
  'sop-templates',
);

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

describe('安全域 SAST 规则 — 真实检出（非空跑）', () => {
  let fixture: string;
  let registry: SopRegistry;
  let engine: SopRuleEngine;
  let semgrepAvailable: boolean;

  beforeEach(async () => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-sec-detect-'));
    registry = new SopRegistry();
    engine = new SopRuleEngine(registry);
    const adapter = new SemgrepAdapter(fixture);
    semgrepAvailable = await adapter.isAvailable();
    engine.registerToolAdapter('semgrep', adapter);
    await new SopLoader(registry, { rulesDir: TEMPLATES_DIR }).loadFromFileSystem();
  });

  afterEach(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  async function evalRule(id: string) {
    const report = await engine.evaluateRules({ repoRoot: fixture, domain: 'security' });
    return report.evaluations.find((e) => e.rule.id === id);
  }

  it('command-injection：exec 拼接用户输入（两参数 + 回调）被检出', async () => {
    if (!semgrepAvailable) return;
    write(
      fixture,
      'src/security/command.js',
      [
        "const { exec } = require('node:child_process');",
        'exports.run = function run(userInput) {',
        "  exec('ls ' + userInput, (err, stdout) => {",
        '    if (err) console.error(err);',
        '    else console.log(stdout);',
        '  });',
        '};',
      ].join('\n'),
    );

    const ev = await evalRule('security.scan.semgrep.command-injection');
    expect(ev).toBeDefined();
    expect(ev!.status).toBe('failed');
    expect(ev!.violations!.length).toBeGreaterThan(0);
  });

  it('sql-injection：字符串拼接进 query 被检出', async () => {
    if (!semgrepAvailable) return;
    write(
      fixture,
      'src/security/unsafe.js',
      [
        'exports.findUser = function findUser(db, username) {',
        "  return db.query('SELECT * FROM users WHERE name = \"' + username + '\"');",
        '};',
      ].join('\n'),
    );

    const ev = await evalRule('security.scan.semgrep.sql-injection');
    expect(ev).toBeDefined();
    expect(ev!.status).toBe('failed');
    expect(ev!.violations!.length).toBeGreaterThan(0);
  });

  it('xss：innerHTML 直接赋值被检出', async () => {
    if (!semgrepAvailable) return;
    write(
      fixture,
      'src/security/render.js',
      [
        'exports.renderComment = function renderComment(el, comment) {',
        '  el.innerHTML = comment;',
        '};',
      ].join('\n'),
    );

    const ev = await evalRule('security.scan.semgrep.xss');
    expect(ev).toBeDefined();
    expect(ev!.status).toBe('failed');
    expect(ev!.violations!.length).toBeGreaterThan(0);
  });

  it('干净项目：三条规则均不误报（反向）', async () => {
    if (!semgrepAvailable) return;
    write(
      fixture,
      'src/security/clean.js',
      [
        "const { execFile } = require('node:child_process');",
        'exports.run = function run(input) {',
        "  execFile('ls', [input]);",
        '};',
        'exports.find = function find(db, id) {',
        "  return db.query('SELECT * FROM users WHERE id = $1', [id]);",
        '};',
        'exports.render = function render(el, text) {',
        '  el.textContent = text;',
        '};',
      ].join('\n'),
    );

    for (const id of [
      'security.scan.semgrep.command-injection',
      'security.scan.semgrep.sql-injection',
      'security.scan.semgrep.xss',
    ]) {
      const ev = await evalRule(id);
      expect(ev!.status).toBe('passed');
    }
  });
});
