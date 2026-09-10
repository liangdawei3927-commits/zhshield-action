import { describe, expect, it, vi, afterEach } from 'vitest';

// 用 vi.hoisted 暴露可变 mock 状态（与 semgrep-adapter-dataflow.test.ts 一致）
const state = vi.hoisted(() => ({
  mockError: { code: 1, stderr: '', message: '' } as {
    code: number;
    stderr: string;
    message: string;
  },
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const cb = args.at(-1) as (err: Error, result?: { stdout: string; stderr: string }) => void;
    const err = Object.assign(new Error(state.mockError.message || 'Command failed'), {
      code: state.mockError.code,
      stderr: state.mockError.stderr,
    });
    cb(err, { stdout: '', stderr: state.mockError.stderr });
  }),
}));

import { execFile } from 'node:child_process';
import { TrivyAdapter } from '../adapters/trivy-adapter';

const execFileMock = vi.mocked(execFile);

afterEach(() => {
  execFileMock.mockClear();
});

describe('TrivyAdapter — 漏洞库下载失败提示', () => {
  it('trivy stderr 含 Need to update DB 下载签名时返回可操作指引而非原始下载日志', async () => {
    state.mockError = {
      code: 1,
      stderr: [
        '2026-09-09T00:04:37+08:00	INFO	[vulndb] Need to update DB',
        '2026-09-09T00:04:37+08:00	INFO	[vulndb] Downloading vulnerability DB...',
        '2026-09-09T00:04:37+08:00	INFO	[vulndb] Downloading artifact...	repo="mirror.gcr.io/aquasec/trivy-db:2"',
      ].join('\n'),
      message: 'Command failed',
    };

    const adapter = new TrivyAdapter();
    const result = await adapter.scan({
      projectPath: '/tmp/trivyprobe',
      projectId: '/tmp/trivyprobe',
      config: { scanners: ['dependency'] },
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Trivy 漏洞库不可用');
    expect(result.error).toContain('TRIVY_SKIP_DB_UPDATE');
    expect(result.error).toContain('TRIVY_DB_REPOSITORY');
    // 不把原始下载噪音原样上报
    expect(result.error).not.toContain('Downloading artifact');
  });

  it('普通 trivy 错误（无 DB 签名）仍原样上报 stderr', async () => {
    state.mockError = {
      code: 1,
      stderr: '2026-09-09T00:04:37+08:00	FATAL	parse error: unexpected character',
      message: 'Command failed',
    };

    const adapter = new TrivyAdapter();
    const result = await adapter.scan({
      projectPath: '/tmp/trivyprobe',
      projectId: '/tmp/trivyprobe',
      config: { scanners: ['config'] },
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('FATAL	parse error');
  });

  it('首次运行设置 --skip-db-update 被 trivy 拒绝（first run cannot skip）同样返回可操作指引', async () => {
    state.mockError = {
      code: 1,
      stderr: [
        '2026-09-09T03:09:40+08:00	ERROR	[vulndb] The first run cannot skip downloading DB',
        '2026-09-09T03:09:40+08:00	FATAL	Fatal error	run error: init error: DB error: database error: --skip-db-update cannot be specified on the first run',
      ].join('\n'),
      message: 'Command failed',
    };

    const adapter = new TrivyAdapter();
    const result = await adapter.scan({
      projectPath: '/tmp/trivyprobe',
      projectId: '/tmp/trivyprobe',
      config: { scanners: ['dependency'] },
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Trivy 漏洞库不可用');
    expect(result.error).toContain('--download-db-only');
  });
});