import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { SemgrepAdapter } from '../adapters/semgrep-adapter';

const execFileMock = vi.mocked(execFile);
const adapter = new SemgrepAdapter();

/** 本机 semgrep-core（OCaml 运行时）每次启动都会打印的无害告警，非扫描失败原因 */
const OCAML_NOISE_STDERR = [
  'Failed to register segfault signal handler! exit_code: 52625665',
  'Failed to register unwind handler for some critical signals, such as SIGSEGV. If we segfault you are on your own and you will receive no backtraces',
].join('\n');

interface MockExecError {
  code?: number | string;
  stdout?: string;
  stderr?: string;
  message?: string;
}

// 模拟 node:child_process.execFile（回调风格，promisify 后单值解析为 { stdout, stderr }）
function mockSuccess(stdout: string, stderr = ''): void {
  execFileMock.mockImplementation(((
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    cb(null, { stdout, stderr });
  }) as never);
}

function mockFailure(err: MockExecError): void {
  execFileMock.mockImplementation(((
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error) => void,
  ) => {
    cb(Object.assign(new Error(err.message ?? 'Command failed'), err) as Error);
  }) as never);
}

function emptyScanOutput(): string {
  return JSON.stringify({ version: '1.172.0', results: [], errors: [] });
}

function tempProject(withSrc: boolean, withPackages = false): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'semgrep-adapter-'));
  if (withSrc) mkdirSync(path.join(dir, 'src'));
  if (withPackages) mkdirSync(path.join(dir, 'packages'));
  return dir;
}

/** 在项目根写入默认 semgrep 规则文件，使注入 config 的守卫分支放行，聚焦目标目录解析 */
function writeDefaultConfig(project: string): void {
  writeFileSync(path.join(project, 'redos.yml'), 'rules: []');
}

/** 容器根项目：含一个嵌套代码仓库（有 package.json + packages/） */
function tempContainerProject(): { root: string; nested: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'semgrep-container-'));
  const nested = path.join(root, 'nested-app');
  mkdirSync(path.join(nested, 'packages'), { recursive: true });
  writeFileSync(path.join(nested, 'package.json'), '{"name":"nested-app"}');
  return { root, nested };
}

function lastTargetArg(): string {
  const args = execFileMock.mock.calls[0][1] as string[];
  return args.at(-1)!;
}

afterEach(() => {
  execFileMock.mockReset();
});

describe('SemgrepAdapter', () => {
  it('扫描失败时优先报告 semgrep JSON errors 中的真实错误，而非 OCaml 运行时噪音', async () => {
    const project = tempProject(false);
    writeDefaultConfig(project);
    try {
      mockFailure({
        code: 2,
        stdout: JSON.stringify({
          version: '1.172.0',
          results: [],
          errors: [{ code: 2, level: 'error', type: 'SemgrepError', message: 'Invalid scanning root: src' }],
        }),
        stderr: OCAML_NOISE_STDERR,
        message: 'Command failed: semgrep scan',
      });

      const result = await adapter.scan({ projectPath: project, projectId: project, config: { enabled: true, config: 'redos.yml' } });

      expect(result.status).toBe('error');
      expect(result.error).toBe('Invalid scanning root: src');
      expect(result.error).not.toContain('Failed to register');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('无 JSON 输出时剔除 stderr 中的 OCaml 运行时噪音后兜底', async () => {
    const project = tempProject(true);
    writeDefaultConfig(project);
    try {
      mockFailure({ code: 1, stdout: '', stderr: OCAML_NOISE_STDERR, message: 'Command failed: semgrep scan' });

      const result = await adapter.scan({ projectPath: project, projectId: project, config: { enabled: true, config: 'redos.yml' } });

      expect(result.status).toBe('error');
      expect(result.error).toBe('Command failed: semgrep scan');
      expect(result.error).not.toContain('Failed to register');
      expect(result.error).not.toContain('unwind handler');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('扫描超时返回明确错误信息', async () => {
    const project = tempProject(true);
    writeDefaultConfig(project);
    try {
      mockFailure({ code: 'ETIMEDOUT', stdout: '', stderr: '', message: 'ETIMEDOUT' });

      const result = await adapter.scan({ projectPath: project, projectId: project, config: { enabled: true, config: 'redos.yml' } });

      expect(result.status).toBe('error');
      expect(result.error).toBe('Semgrep 扫描超时');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('未配置规则集（无 config 且无内联 rules）时返回 unavailable，禁止裸跑 registry auto', async () => {
    const project = tempProject(true);
    try {
      const result = await adapter.scan({ projectPath: project, projectId: project, config: { enabled: true } });

      expect(result.status).toBe('unavailable');
      expect(result.error).toContain('未配置规则集');
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('semgrep 存在 findings（退出码 1）时正常映射问题', async () => {
    const project = tempProject(true);
    writeDefaultConfig(project);
    try {
      mockFailure({
        code: 1,
        stdout: JSON.stringify({
          version: '1.172.0',
          results: [{
            check_id: 'detect-redos',
            path: 'src/a.js',
            start: { line: 2, col: 1 },
            extra: { severity: 'WARNING', message: 'ReDoS risk' },
          }],
          errors: [],
        }),
        stderr: OCAML_NOISE_STDERR,
        message: 'Command failed',
      });

      const result = await adapter.scan({
        projectPath: project,
        projectId: project,
        config: { enabled: true, category: 'performance', config: 'redos.yml' },
      });

      expect(result.status).toBe('available');
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].ruleId).toBe('detect-redos');
      expect(result.issues[0].category).toBe('performance');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('目标目录解析：src → packages → 项目根 依次回退', async () => {
    const withSrc = tempProject(true);
    writeDefaultConfig(withSrc);
    try {
      mockSuccess(emptyScanOutput(), OCAML_NOISE_STDERR);
      await adapter.scan({ projectPath: withSrc, projectId: withSrc, config: { enabled: true, config: 'redos.yml' } });
      expect(lastTargetArg()).toBe(path.join(withSrc, 'src'));
    } finally {
      rmSync(withSrc, { recursive: true, force: true });
    }

    const withPackages = tempProject(false, true);
    writeDefaultConfig(withPackages);
    try {
      execFileMock.mockReset();
      mockSuccess(emptyScanOutput(), OCAML_NOISE_STDERR);
      await adapter.scan({ projectPath: withPackages, projectId: withPackages, config: { enabled: true, config: 'redos.yml' } });
      expect(lastTargetArg()).toBe(path.join(withPackages, 'packages'));
    } finally {
      rmSync(withPackages, { recursive: true, force: true });
    }

    const bare = tempProject(false);
    writeDefaultConfig(bare);
    try {
      execFileMock.mockReset();
      mockSuccess(emptyScanOutput(), OCAML_NOISE_STDERR);
      await adapter.scan({ projectPath: bare, projectId: bare, config: { enabled: true, config: 'redos.yml' } });
      expect(lastTargetArg()).toBe(bare);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('容器根项目：下探到嵌套代码仓库的 packages 目录，避免全量扫描', async () => {
    const container = tempContainerProject();
    const nestedPkg = path.join(container.nested, 'packages');
    writeDefaultConfig(container.root);
    try {
      mockSuccess(emptyScanOutput(), OCAML_NOISE_STDERR);
      await adapter.scan({ projectPath: container.root, projectId: container.root, config: { enabled: true, config: 'redos.yml' } });
      expect(lastTargetArg()).toBe(nestedPkg);
    } finally {
      rmSync(container.root, { recursive: true, force: true });
    }
  });

  it('注入 config 缺失时返回 unavailable 并跳过 semgrep 调用', async () => {
    const project = tempProject(true);
    try {
      const result = await adapter.scan({
        projectPath: project,
        projectId: project,
        config: { enabled: true, config: 'node_modules/@zh/kernel/dist/assets/semgrep/redos.yml' },
      });

      expect(result.status).toBe('unavailable');
      expect(result.error).toContain('不存在');
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('扫描参数排除测试夹具目录，避免把刻意构造的恶意样例当生产代码', async () => {
    const project = tempProject(true);
    writeDefaultConfig(project);
    try {
      mockSuccess(emptyScanOutput(), OCAML_NOISE_STDERR);
      await adapter.scan({ projectPath: project, projectId: project, config: { enabled: true, config: 'redos.yml' } });

      const args = execFileMock.mock.calls[0][1] as string[];
      const excludes: string[] = [];
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === '--exclude') excludes.push(args[i + 1]);
      }

      expect(excludes).toEqual(expect.arrayContaining(['__tests__', 'fixtures', '__fixtures__', '__mocks__']));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('内联规则含 metavariableRegex 时写入 metavariable-regex 块，收紧元变量避免误报', async () => {
    const project = tempProject(true);
    try {
      mockSuccess(emptyScanOutput(), OCAML_NOISE_STDERR);
      await adapter.scan({
        projectPath: project,
        projectId: project,
        config: {
          enabled: true,
          rules: [{
            id: 'path-join-user-input',
            pattern: 'path.join($BASE_DIR, $USER_INPUT)',
            severity: 'error',
            message: '用户输入直接用于路径拼接可能导致路径遍历',
            metavariableRegex: [{
              metavariable: '$USER_INPUT',
              regex: '^(req|request|ctx|context|query|params|body|input|userInput|user_input|argv|form|process\\.env)[\\.\\w]*$',
            }],
          }],
        },
      });

      const args = execFileMock.mock.calls[0][1] as string[];
      const configIndex = args.indexOf('--config');
      const rulePath = args[configIndex + 1];

      const yaml = readFileSync(rulePath, 'utf-8');
      expect(yaml).toContain('      - pattern: |');
      expect(yaml).toContain('      - metavariable-regex:');
      expect(yaml).toContain('          metavariable: $USER_INPUT');
      expect(yaml).toContain('regex:');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('内联规则含 patternEither 时渲染 pattern-either 块，且 patternNot 作为同级排除项', async () => {
    const project = tempProject(true);
    try {
      mockSuccess(emptyScanOutput(), OCAML_NOISE_STDERR);
      await adapter.scan({
        projectPath: project,
        projectId: project,
        config: {
          enabled: true,
          rules: [{
            id: 'sql-injection-concat',
            patternEither: [
              'const $QUERY = "..." + $INPUT\n$DB.query($QUERY)',
              '$DB.query("..." + $INPUT)',
            ],
            patternNot: ['$DB.query("...")'],
            severity: 'error',
            message: 'SQL 注入',
          }],
        },
      });

      const args = execFileMock.mock.calls[0][1] as string[];
      const configIndex = args.indexOf('--config');
      const rulePath = args[configIndex + 1];

      const yaml = readFileSync(rulePath, 'utf-8');
      expect(yaml).toContain('      - pattern-either:');
      expect(yaml).toContain('          - pattern: |');
      expect(yaml).toContain('              const $QUERY = "..." + $INPUT');
      expect(yaml).toContain('              $DB.query($QUERY)');
      expect(yaml).toContain('      - pattern-not: |');
      expect(yaml).toContain('          $DB.query("...")');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('内联规则含 patternNot 时渲染受约束 pattern（patterns 序列 + pattern-not）', async () => {
    const project = tempProject(true);
    try {
      mockSuccess(emptyScanOutput(), OCAML_NOISE_STDERR);
      await adapter.scan({
        projectPath: project,
        projectId: project,
        config: {
          enabled: true,
          rules: [{
            id: 'child-process-exec',
            pattern: 'exec($VAR)',
            patternNot: ['exec("...")'],
            severity: 'error',
            message: '命令注入',
          }],
        },
      });

      const args = execFileMock.mock.calls[0][1] as string[];
      const configIndex = args.indexOf('--config');
      const rulePath = args[configIndex + 1];

      const yaml = readFileSync(rulePath, 'utf-8');
      expect(yaml).toContain('    patterns:');
      expect(yaml).toContain('      - pattern: |');
      expect(yaml).toContain('      - pattern-not: |');
      expect(yaml).toContain('          exec("...")');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('内联规则含 patternRegex 时渲染顶层 pattern-regex（generic 场景）', async () => {
    const project = tempProject(true);
    try {
      mockSuccess(emptyScanOutput(), OCAML_NOISE_STDERR);
      await adapter.scan({
        projectPath: project,
        projectId: project,
        config: {
          enabled: true,
          rules: [{
            id: 'cors-wildcard',
            patternRegex: 'Access-Control-Allow-Origin\\s*[:=]\\s*[*]',
            severity: 'warning',
            message: 'CORS 通配符',
            languages: ['generic'],
          }],
        },
      });

      const args = execFileMock.mock.calls[0][1] as string[];
      const configIndex = args.indexOf('--config');
      const rulePath = args[configIndex + 1];

      const yaml = readFileSync(rulePath, 'utf-8');
      expect(yaml).toContain('    pattern-regex: Access-Control-Allow-Origin\\s*[:=]\\s*[*]');
      expect(yaml).toContain('languages: [generic]');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
