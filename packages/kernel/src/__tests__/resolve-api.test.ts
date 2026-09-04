import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  readApiToken,
  resolveTools,
  resolveRules,
  registerProjectFeatures,
  health,
} from '../sop/sync/resolve-api';

const TOKEN_FILE = path.join(os.homedir(), '.zhshield', '.api-token');

describe('readApiToken', () => {
  it('returns a 64-char hex string', () => {
    const token = readApiToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns stable value across calls', () => {
    const first = readApiToken();
    const second = readApiToken();
    expect(first).toBe(second);
  });

  it('matches the file on disk', () => {
    const token = readApiToken();
    const onDisk = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
    expect(token).toBe(onDisk);
  });

  it('token file has 0o600 permissions', () => {
    readApiToken();
    const stat = fs.statSync(TOKEN_FILE);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('resolve-api network functions', () => {
  const mockBase = 'http://localhost:9999/api/v1';
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('resolveTools', () => {
    it('POSTs to /resolve/tools with orgId and feature', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ tools: ['semgrep', 'trivy'] }),
      });

      const result = await resolveTools(
        'org-1',
        { language: 'go', features: [] },
        mockBase,
      );
      expect(result).toEqual(['semgrep', 'trivy']);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${mockBase}/resolve/tools`);
      expect(opts.method).toBe('POST');
      const body = JSON.parse(String(opts.body)) as Record<string, unknown>;
      expect(body.orgId).toBe('org-1');
      expect(body.projectFeature).toEqual({ language: 'go', features: [] });
      expect(opts.headers).toHaveProperty('x-api-token');
    });

    it('omits projectFeature when feature is undefined', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ tools: ['semgrep'] }),
      });

      await resolveTools('org-1', undefined, mockBase);
      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty('projectFeature');
    });
  });

  describe('resolveRules', () => {
    it('POSTs to /resolve/rules with all params', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          rules: [{ ruleId: 'r1', version: '1.0', sha: null, source: 'manual' }],
          changed: ['r1'],
        }),
      });

      const result = await resolveRules(
        'org-1',
        { language: 'typescript', features: [] },
        { 'r1': '0.9' },
        mockBase,
      );
      expect(result.rules).toHaveLength(1);
      expect(result.changed).toEqual(['r1']);
      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body)) as Record<string, unknown>;
      expect(body.orgId).toBe('org-1');
      expect(body.currentVersions).toEqual({ r1: '0.9' });
    });
  });

  describe('registerProjectFeatures', () => {
    it('PUTs to /orgs/:orgId/projects/:projectId/features', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, projectId: 'p1', orgId: 'org-1' }),
      });

      await registerProjectFeatures('org-1', 'user-1', 'p1', {
        framework: 'react',
        language: 'typescript',
        features: ['spa'],
      }, mockBase);

      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${mockBase}/orgs/org-1/projects/p1/features`);
      expect(opts.method).toBe('PUT');
      const body = JSON.parse(String(opts.body)) as Record<string, unknown>;
      expect(body.userId).toBe('user-1');
      expect(body.framework).toBe('react');
      expect(body.language).toBe('typescript');
      expect(body.features).toEqual(['spa']);
    });
  });

  describe('health', () => {
    it('returns true when server responds ok', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      });
      expect(await health(mockBase)).toBe(true);
    });

    it('returns false on network failure', async () => {
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
      expect(await health(mockBase)).toBe(false);
    });

    it('returns false on non-2xx response', async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 500 });
      expect(await health(mockBase)).toBe(false);
    });
  });
});
