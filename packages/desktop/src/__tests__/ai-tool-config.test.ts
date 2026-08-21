import { describe, it, expect } from 'vitest';
import {
  AI_TOOL_PRESETS,
  buildIntegrationJson,
  buildOpenCodeCommand,
  buildToolConfigFile,
  buildIntegrationFiles,
} from '../../electron/ai-tool-config';

describe('AI_TOOL_PRESETS', () => {
  it('内置 OpenCode 预设，默认未启用', () => {
    expect(AI_TOOL_PRESETS.opencode).toMatchObject({
      id: 'opencode',
      name: 'OpenCode',
      enabled: false,
      mode: 'linter',
      configFile: '.opencode/command/zhshield.md',
    });
  });
});

describe('buildIntegrationJson', () => {
  it('生成合法的 integration.json（协议 4.4 字段）', () => {
    const raw = buildIntegrationJson(AI_TOOL_PRESETS.opencode);
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe('1.0');
    expect(parsed.tool).toBe('opencode');
    expect(parsed.auto_invoke.on_commit).toBe(true);
    expect(parsed.linter.watch_dir).toBe('.zhshield/diagnostics');
    expect(parsed.filters.categories).toContain('security');
  });
});

describe('buildOpenCodeCommand', () => {
  it('命令文件包含 frontmatter 与修复工作流', () => {
    const content = buildOpenCodeCommand();
    expect(content).toContain('description: 读取智汇码盾诊断并修复代码问题');
    expect(content).toContain('.zhshield/diagnostics/latest.json');
    expect(content).toContain('zhshield issue resolve');
  });
});

describe('buildToolConfigFile', () => {
  it('OpenCode 返回命令文件内容', () => {
    expect(buildToolConfigFile(AI_TOOL_PRESETS.opencode)).toContain('# 智汇码盾诊断修复');
  });

  it('未知工具返回 null，仅保留协议标准文件', () => {
    const unknown = { ...AI_TOOL_PRESETS.opencode, id: 'unknown-tool' };
    expect(buildToolConfigFile(unknown)).toBeNull();
  });
});

describe('buildIntegrationFiles', () => {
  it('OpenCode 生成 2 个文件：协议文件 + 命令文件', () => {
    const files = buildIntegrationFiles(AI_TOOL_PRESETS.opencode);
    expect(files.map((f) => f.path)).toEqual([
      '.zhshield/integration.json',
      '.opencode/command/zhshield.md',
    ]);
    expect(files[0].content).toContain('"tool": "opencode"');
  });

  it('未知工具仅生成 integration.json', () => {
    const unknown = { ...AI_TOOL_PRESETS.opencode, id: 'unknown-tool' };
    const files = buildIntegrationFiles(unknown);
    expect(files.map((f) => f.path)).toEqual(['.zhshield/integration.json']);
  });
});
