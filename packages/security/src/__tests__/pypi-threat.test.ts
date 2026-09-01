import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanPypiThreats } from '../pypi-threat-scanner';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('scanPypiThreats', () => {
  it('flags known malicious packages from requirements.txt', async () => {
    const dir = tmpDir('zh-pypi-mal-');
    fs.writeFileSync(
      path.join(dir, 'requirements.txt'),
      ['requests==2.26.0', 'pytorch==1.0.0'].join('\n'),
    );

    const items = await scanPypiThreats(dir);

    const hit = items.find((i) => i.evidence.includes('pytorch'));
    expect(hit).toBeDefined();
    expect(hit?.type).toBe('supply-chain');
    expect(hit?.severity).toBe('critical');
    expect(hit?.pattern).toBe('pypi-threat-db');
    expect(hit?.title).toContain('已知恶意 PyPI');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flags typosquatting packages against popular names', async () => {
    const dir = tmpDir('zh-pypi-squat-');
    fs.writeFileSync(
      path.join(dir, 'requirements.txt'),
      ['# comment line', 'flask>=2.0', 'requets>=2.0'].join('\n'),
    );

    const items = await scanPypiThreats(dir);

    const hit = items.find((i) => i.evidence.includes('requets'));
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('high');
    expect(hit?.pattern).toBe('typosquat:requests:1');
    expect(hit?.evidence).toContain('requests');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not flag legitimate popular packages', async () => {
    const dir = tmpDir('zh-pypi-ok-');
    fs.writeFileSync(
      path.join(dir, 'requirements.txt'),
      [
        'requests==2.26.0',
        'numpy>=1.0',
        'pandas',
        'urllib3',
        'scikit-learn',
        'flask[async]>=2.0',
      ].join('\n'),
    );

    expect(await scanPypiThreats(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flags known malicious packages from Pipfile.lock default section', async () => {
    const dir = tmpDir('zh-pypi-pipfile-');
    fs.writeFileSync(
      path.join(dir, 'Pipfile.lock'),
      JSON.stringify({
        _meta: { hash: { sha256: 'abc' } },
        default: {
          pytorch: { version: '==1.0.0' },
          requests: { version: '==2.26.0' },
        },
        develop: {
          pytest: { version: '==7.0.0' },
        },
      }),
    );

    const items = await scanPypiThreats(dir);

    const hit = items.find((i) => i.evidence.includes('pytorch'));
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('critical');
    expect(hit?.pattern).toBe('pypi-threat-db');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flags typosquatting from pyproject.toml [project] dependencies', async () => {
    const dir = tmpDir('zh-pypi-pyproject-');
    fs.writeFileSync(
      path.join(dir, 'pyproject.toml'),
      [
        '[project]',
        'name = "demo"',
        'dependencies = [',
        '    "requests",',
        '    "requets",',
        ']',
        '',
        '[tool.pytest.ini_options]',
        'testpaths = ["tests"]',
      ].join('\n'),
    );

    const items = await scanPypiThreats(dir);

    const hit = items.find((i) => i.evidence.includes('requets'));
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('high');
    expect(hit?.pattern).toBe('typosquat:requests:1');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty for missing manifest or corrupt requirements', async () => {
    const empty = tmpDir('zh-pypi-none-');
    expect(await scanPypiThreats(empty)).toEqual([]);

    const corrupt = tmpDir('zh-pypi-bad-');
    fs.writeFileSync(path.join(corrupt, 'requirements.txt'), '\u0000\u0001\x7fnot-a-valid-spec@@');
    expect(await scanPypiThreats(corrupt)).toEqual([]);

    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(corrupt, { recursive: true, force: true });
  });
});
