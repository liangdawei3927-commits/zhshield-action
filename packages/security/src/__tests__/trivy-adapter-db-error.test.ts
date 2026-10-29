import { describe, expect, it, vi, afterEach } from 'vitest';

// 用 vi.hoisted 暴露可变 mock 状态（与 semgrep-adapter-dataflow.test.ts 一致）
const state = vi.hoisted(() => ({
  mockError: { code: 1, stderr: '', message: '' } as {
    code: number;
    stderr: string;
    message: string;
  },
  // package.json 存在性（dependency 扫描前置检查）：默认存在，走真实扫描路径
  packageJsonExists: true,
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

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => state.packageJsonExists),
  // 适配 trivy-adapter 的 async 化改造：package.json 存在性检查改用 fs.promises.access，
  // 必须跟随同一 state.packageJsonExists 开关；否则 mock 模块缺 promises 属性时，
  // fs.promises.access 抛错被 try/catch 捕获，会误判为"无 package.json"短路返回 unavailable。
  promises: {
    access: vi.fn(() =>
      state.packageJsonExists ? Promise.resolve() : Promise.reject(new Error('ENOENT')),
    ),
  },
}));

import { execFile } from 'node:child_process';
import { TrivyAdapter } from '../adapters/trivy-adapter';

const execFileMock = vi.mocked(execFile);

afterEach(() => {
  execFileMock.mockClear();
  state.packageJsonExists = true;
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

describe('TrivyAdapter — 无 package.json 的 dependency 扫描（防 (root) 伪债务）', () => {
  // 回归背景：扫描根无 Node 清单时 trivy 对 package.json lstat FATAL，
  // 错误曾被诊断链路聚合为 (root) 伪债务项（td-quality-44c4ce057952）。
  it('dependency 扫描且根目录无 package.json 时按 skipped/out-of-scope 处理且不执行 trivy', async () => {
    state.packageJsonExists = false;

    const adapter = new TrivyAdapter();
    const result = await adapter.scan({
      projectPath: '/tmp/trivyprobe',
      projectId: '/tmp/trivyprobe',
      config: { scanners: ['dependency'] },
    });

    // 范围外 = 既定裁剪，不是工具不可用：用 skipped 而非 unavailable。
    // 曾因返回 unavailable 被 escalate 进 degraded.unavailableTools，
    // 令「本项目无 Node 清单」渲染成「Trivy 未安装」并指引用户重装（无效动作）。
    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('out-of-scope');
    expect(result.issues).toEqual([]);
    expect(result.error).toContain('无 package.json');
    // 范围外跳过：绝不能真的拉起 trivy（否则又产出 lstat FATAL 伪 error）
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('filesystem 扫描不受 package.json 前置检查影响（全目录扫描无清单也可执行）', async () => {
    state.packageJsonExists = false;
    state.mockError = {
      code: 1,
      stderr: '2026-10-22T23:19:48+08:00\tFATAL\tFatal error\trun error: fs scan error',
      message: 'Command failed',
    };

    const adapter = new TrivyAdapter();
    const result = await adapter.scan({
      projectPath: '/tmp/trivyprobe',
      projectId: '/tmp/trivyprobe',
      config: { scanners: ['filesystem'] },
    });

    // 未被前置检查短路：真实拉起了 trivy（此处 mock 失败 → 透传 error）
    expect(execFileMock).toHaveBeenCalled();
    expect(result.status).toBe('error');
  });
});
