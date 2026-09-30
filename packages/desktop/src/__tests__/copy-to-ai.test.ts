import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildAiFixPrompt, copyTextToClipboard, type AiFixIssue } from '../utils/copyToAi';

describe('buildAiFixPrompt', () => {
  it('包含项目路径与修复要求', () => {
    const prompt = buildAiFixPrompt('/proj', []);
    expect(prompt).toContain('项目路径: /proj');
    expect(prompt).toContain('只做最小必要的修改');
  });

  it('包含执行方式段（技能优先、命令兜底）', () => {
    const prompt = buildAiFixPrompt('/proj', []);
    expect(prompt).toContain('执行方式：');
    expect(prompt).toContain('检查 / 修复技能');
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

describe('buildAiFixPrompt 按语义域分发处理要求', () => {
  it('已知域注入该域专用要求段（不含通用要求）', () => {
    const prompt = buildAiFixPrompt('/proj', [
      {
        source: '密钥管理',
        ruleId: 'hardcoded-key',
        file: 'src/config.ts',
        line: 12,
        message: '检测到硬编码密钥',
        domain: 'secrets',
      },
    ]);
    expect(prompt).toContain('处理要求（密钥泄露类）：');
    expect(prompt).toContain('不得输出密钥原文');
    expect(prompt).not.toContain('只做最小必要的修改');
  });

  it('混合多个域时按首次出现顺序输出多段要求', () => {
    const prompt = buildAiFixPrompt('/proj', [
      { source: '密钥管理', ruleId: 'key-1', message: '密钥', domain: 'secrets' },
      { source: '依赖管家', ruleId: 'typosquat', message: '仿冒包', domain: 'deps' },
      { source: '门禁·预防', ruleId: 'gate-1', message: '失败', domain: 'guard' },
    ]);
    const idxSecrets = prompt.indexOf('处理要求（密钥泄露类）：');
    const idxDeps = prompt.indexOf('处理要求（依赖风险类）：');
    const idxGuard = prompt.indexOf('处理要求（门禁类）：');
    expect(idxSecrets).toBeGreaterThan(-1);
    expect(idxDeps).toBeGreaterThan(idxSecrets);
    expect(idxGuard).toBeGreaterThan(idxDeps);
  });

  it('相同域多条问题只输出一段要求', () => {
    const prompt = buildAiFixPrompt('/proj', [
      { source: '性能', ruleId: 'sync-block', message: '同步阻塞', domain: 'performance' },
      { source: '性能', ruleId: 'dup-calc', message: '重复计算', domain: 'performance' },
    ]);
    const matches = prompt.split('处理要求（性能类）：').length - 1;
    expect(matches).toBe(1);
  });

  it('未知域回退通用要求段', () => {
    const prompt = buildAiFixPrompt('/proj', [
      { source: '未知页', ruleId: 'unknown-rule', message: '问题', domain: 'not-a-domain' },
    ]);
    expect(prompt).toContain('处理要求：');
    expect(prompt).toContain('逐一核实问题真实存在');
    expect(prompt).not.toContain('处理要求（');
  });

  it('无 domain 的问题回退通用要求段', () => {
    const prompt = buildAiFixPrompt('/proj', [
      { source: '巡检', ruleId: 'tool/conf', message: '工具配置错误' },
    ]);
    expect(prompt).toContain('处理要求：');
    expect(prompt).toContain('只做最小必要的修改');
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
    const writeText = vi
      .fn()
      .mockRejectedValue(new DOMException('Write permission denied.', 'NotAllowedError'));
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
