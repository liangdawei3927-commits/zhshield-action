import { describe, it, expect } from 'vitest';
import {
  buildOpenCodeConfigJson,
  type OpenCodeMcpBlock,
} from '../../electron/ai-tool-config';

function mcpBlock(overrides: Partial<OpenCodeMcpBlock> = {}): OpenCodeMcpBlock {
  return {
    type: 'local',
    command: ['node', '/app/dist-electron/zhshield-mcp.js'],
    enabled: true,
    ...overrides,
  };
}

describe('buildOpenCodeConfigJson', () => {
  it('无既有配置时生成含 mcp.zhshield 的完整配置', () => {
    const json = buildOpenCodeConfigJson(null, mcpBlock());
    const parsed = JSON.parse(json);
    expect(parsed.$schema).toBe('https://opencode.ai/config.json');
    expect(parsed.mcp.zhshield).toEqual({
      type: 'local',
      command: ['node', '/app/dist-electron/zhshield-mcp.js'],
      enabled: true,
    });
  });

  it('既有配置时保留用户已有键，仅合并 mcp.zhshield', () => {
    const existing = JSON.stringify({ model: 'anthropic/claude-sonnet-4-5', mcp: { context7: { type: 'remote', url: 'https://mcp.context7.com/mcp' } } });
    const parsed = JSON.parse(buildOpenCodeConfigJson(existing, mcpBlock()));
    expect(parsed.model).toBe('anthropic/claude-sonnet-4-5');
    expect(parsed.mcp.context7).toEqual({ type: 'remote', url: 'https://mcp.context7.com/mcp' });
    expect(parsed.mcp.zhshield).toEqual(mcpBlock());
  });

  it('既有配置已含 zhshield 时被新块覆盖', () => {
    const existing = JSON.stringify({ mcp: { zhshield: { type: 'local', command: ['old'], enabled: false } } });
    const parsed = JSON.parse(buildOpenCodeConfigJson(existing, mcpBlock()));
    expect(parsed.mcp.zhshield).toEqual(mcpBlock());
  });

  it('停用（mcpBlock=null）时移除 zhshield，保留其他键与其他 mcp', () => {
    const existing = JSON.stringify({
      model: 'anthropic/claude-sonnet-4-5',
      mcp: { zhshield: { type: 'local', command: ['x'], enabled: true }, context7: { type: 'remote', url: 'u' } },
    });
    const parsed = JSON.parse(buildOpenCodeConfigJson(existing, null));
    expect(parsed.model).toBe('anthropic/claude-sonnet-4-5');
    expect(parsed.mcp.zhshield).toBeUndefined();
    expect(parsed.mcp.context7).toEqual({ type: 'remote', url: 'u' });
  });

  it('停用时若 mcp 只剩 zhshield，则整个 mcp 键被移除', () => {
    const existing = JSON.stringify({ mcp: { zhshield: { type: 'local', command: ['x'], enabled: true } } });
    const parsed = JSON.parse(buildOpenCodeConfigJson(existing, null));
    expect(parsed.mcp).toBeUndefined();
  });

  it('空既有配置停用时输出空对象', () => {
    const parsed = JSON.parse(buildOpenCodeConfigJson('', null));
    expect(parsed).toEqual({});
  });

  it('既有配置不是合法 JSON 时返回 null（调用方跳过写入）', () => {
    expect(buildOpenCodeConfigJson('{ not valid json', mcpBlock())).toBeNull();
  });
});
