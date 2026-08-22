import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildAiFixPrompt, copyTextToClipboard, type AiFixIssue } from '../utils/copyToAi';

describe('buildAiFixPrompt', () => {
  it('包含项目路径与修复要求', () => {
    const prompt = buildAiFixPrompt('/proj', []);
    expect(prompt).toContain('项目路径: /proj');
    expect(prompt).toContain('只做最小必要的修改');
  });

  it('逐条格式化问题（来源/规则/严重度/位置/描述/建议）', () => {
    const issues: AiFixIssue[] = [
      {
        source: '门禁·预防',
        ruleId: 'sensitive-info',
        severity: '高危',
        file: 'src/config.ts',
        line: 12,
        column: 5,
        message: '检测到硬编码密钥',
        suggestion: '使用环境变量替代',
      },
      { source: '巡检', ruleId: 'eslint/no-console', message: '禁止 console 输出' },
    ];
    const prompt = buildAiFixPrompt('/proj', issues);
    expect(prompt).toContain('【问题 1】（门禁·预防）');
    expect(prompt).toContain('- 规则: sensitive-info');
    expect(prompt).toContain('- 严重度: 高危');
    expect(prompt).toContain('- 位置: src/config.ts:12:5');
    expect(prompt).toContain('- 描述: 检测到硬编码密钥');
    expect(prompt).toContain('- 建议: 使用环境变量替代');
    expect(prompt).toContain('【问题 2】（巡检）');
    expect(prompt).toContain('- 规则: eslint/no-console');
  });

  it('缺少文件信息时省略位置行', () => {
    const prompt = buildAiFixPrompt('/proj', [
      { source: '巡检', ruleId: 'tool/conf', message: '工具配置错误' },
    ]);
    expect(prompt).not.toContain('- 位置:');
  });
});

describe('copyTextToClipboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubDocument(execCommandImpl: () => boolean) {
    const textarea = {
      value: '',
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      select: vi.fn(),
    };
    const document = {
      createElement: vi.fn(() => textarea),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      execCommand: vi.fn(execCommandImpl),
    };
    vi.stubGlobal('document', document);
    return { document, textarea };
  }

  it('Async Clipboard API 可用时直接写入并返回 true', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    stubDocument(() => true);

    await expect(copyTextToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it('writeText 被拒绝（NotAllowedError）时降级 execCommand 复制成功返回 true', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('Write permission denied.', 'NotAllowedError'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { textarea } = stubDocument(() => true);

    await expect(copyTextToClipboard('fallback-text')).resolves.toBe(true);
    expect(textarea.value).toBe('fallback-text');
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });

  it('clipboard API 不存在且 execCommand 复制失败时返回 false', async () => {
    vi.stubGlobal('navigator', {});
    stubDocument(() => false);

    await expect(copyTextToClipboard('hello')).resolves.toBe(false);
  });
});
