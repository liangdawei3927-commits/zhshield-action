import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SentinelService } from '../sentinel/sentinel.service';

describe('SentinelService', () => {
  let service: SentinelService;

  beforeEach(() => {
    service = new SentinelService();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(service).toBeDefined();
    });

    it('should have an event center', () => {
      expect(service.getEventCenter()).toBeDefined();
    });

    it('should have a file monitor', () => {
      expect(service.getFileMonitor()).toBeDefined();
    });

    it('should have a process monitor', () => {
      expect(service.getProcessMonitor()).toBeDefined();
    });

    it('should have a log collector', () => {
      expect(service.getLogCollector()).toBeDefined();
    });

    it('should have an auto fixer', () => {
      expect(service.getAutoFixer()).toBeDefined();
    });
  });

  describe('initialize', () => {
    it('should initialize without db path', async () => {
      await expect(service.initialize()).resolves.toBeUndefined();
    });

    it('should initialize with invalid db path gracefully', async () => {
      await expect(service.initialize('/tmp/zh-test-nonexistent/db.sqlite')).resolves.toBeUndefined();
    });
  });

  describe('listEvents', () => {
    it('should return empty array initially', () => {
      const events = service.listEvents();
      expect(events).toEqual([]);
    });
  });

  describe('getEvent', () => {
    it('should return undefined for unknown event', () => {
      const event = service.getEvent('nonexistent');
      expect(event).toBeUndefined();
    });
  });

  describe('processWebhook', () => {
    it('should reject invalid payload', () => {
      const result = service.processWebhook('token', null);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('invalid payload');
    });

    it('should reject payload without alerts array', () => {
      const result = service.processWebhook('token', { notAlerts: [] });
      expect(result.accepted).toBe(false);
    });

    it('should accept valid webhook payload with proper alerts', () => {
      const payload = {
        alerts: [{
          fingerprint: 'fp-1',
          labels: {
            alertname: 'TestAlert',
            service: 'api',
            module: 'auth',
            severity: 'critical',
            repo: 'test-repo',
          },
          annotations: {
            summary: 'Test alert summary',
          },
        }],
      };
      const result = service.processWebhook('token', payload);
      expect(result.accepted).toBe(true);
      expect(result.eventId).toBeDefined();
    });

    it('should deduplicate repeated alerts', () => {
      const payload = {
        alerts: [{
          fingerprint: 'fp-dedup',
          labels: {
            alertname: 'DedupAlert',
            service: 'api',
            module: 'cache',
            severity: 'high',
            repo: 'test-repo',
          },
          annotations: {
            summary: 'Dedup test',
          },
        }],
      };
      const first = service.processWebhook('token', payload);
      const second = service.processWebhook('token', payload);
      expect(first.accepted).toBe(true);
      expect(first.eventId).toBe(second.eventId);
    });
  });

  describe('startFileMonitor', () => {
    it('默认排除依赖/测试产物目录，不产生噪音事件', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-server-sentinel-'));
      try {
        await service.startFileMonitor('proj-1', [root]);
        fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
        fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
        fs.writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'x');
        fs.writeFileSync(path.join(root, 'test-results', '.last-run.json'), '{}');
        const realFile = path.join(root, 'src', 'app.ts');
        fs.mkdirSync(path.dirname(realFile), { recursive: true });
        fs.writeFileSync(realFile, 'console.log(1)');

        await new Promise((r) => setTimeout(r, 300));

        const events = service.listEvents();
        expect(events.some((e) => e.context?.filePath?.toString().includes('node_modules'))).toBe(false);
        expect(events.some((e) => e.context?.filePath?.toString().includes('test-results'))).toBe(false);
        expect(events.some((e) => e.context?.filePath === realFile)).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('onModuleDestroy', () => {
    it('should shut down gracefully', () => {
      expect(() => service.onModuleDestroy()).not.toThrow();
    });
  });
});
