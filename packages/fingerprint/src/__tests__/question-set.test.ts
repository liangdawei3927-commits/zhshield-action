// QuestionSet 单测：问题生成 / 阶梯触发 / 优先级排序

import { describe, expect, it } from 'vitest';
import { QuestionSet, createDefaultServes } from '../question-set';
import type { ProjectProfile, RuleServes } from '../types';

// ─── 测试辅助 ───

function makeTestProfile(overrides?: Partial<ProjectProfile>): ProjectProfile {
  return {
    schemaVersion: 1,
    architecture: { value: 'monolith', confidence: 0.8, signals: [] },
    targets: [
      {
        id: 'default',
        path: '/test/project',
        language: { value: 'typescript', confidence: 0.95, signals: [] },
        frameworks: [{ value: 'Next.js', confidence: 0.9, signals: [] }],
        routeKey: 'typescript:Next.js:*',
      },
    ],
    environments: [{ value: 'node', confidence: 1.0, signals: [] }],
    dependencies: { direct: [] },
    detectedAt: '2026-08-17T00:00:00.000Z',
    stale: false,
    signals: [],
    overrides: {},
    ...overrides,
  };
}

function makeServes(overrides?: Partial<RuleServes>): RuleServes {
  return {
    languages: ['typescript', 'javascript', 'python'],
    productForms: ['website', 'admin', 'mobile', 'miniapp', 'pc', 'h5', 'backend'],
    architectures: ['monolith', 'modular-monolith', 'microservices'],
    ...overrides,
  };
}

// ─── 测试用例 ───

describe('QuestionSet', () => {
  describe('架构形态问题', () => {
    it('GIVEN 首次扫描 (lastConfirmedAt=undefined) WHEN generate THEN 生成架构问题', () => {
      const profile = makeTestProfile({
        lastConfirmedAt: undefined,
      });

      const questionSet = new QuestionSet(makeServes());
      const questions = questionSet.generate(profile);

      const archQuestion = questions.find((q) => q.type === 'architecture');
      expect(archQuestion).toBeDefined();
      expect(archQuestion?.priority).toBe('required');
    });

    it('GIVEN 置信度 < 0.7 WHEN generate THEN 生成架构问题', () => {
      const profile = makeTestProfile({
        architecture: { value: 'monolith', confidence: 0.5, signals: [] },
        lastConfirmedAt: '2026-08-17T00:00:00.000Z',
      });

      const questionSet = new QuestionSet(makeServes());
      const questions = questionSet.generate(profile);

      const archQuestion = questions.find((q) => q.type === 'architecture');
      expect(archQuestion).toBeDefined();
    });

    it('GIVEN 置信度 >= 0.7 + 已确认 WHEN generate THEN 不生成架构问题', () => {
      const profile = makeTestProfile({
        architecture: { value: 'monolith', confidence: 0.8, signals: [] },
        lastConfirmedAt: '2026-08-17T00:00:00.000Z',
      });

      const questionSet = new QuestionSet(makeServes());
      const questions = questionSet.generate(profile);

      const archQuestion = questions.find((q) => q.type === 'architecture');
      expect(archQuestion).toBeUndefined();
    });

    it('GIVEN 规则库不支持架构维度 WHEN generate THEN 不生成架构问题', () => {
      const profile = makeTestProfile({
        lastConfirmedAt: undefined,
      });

      const questionSet = new QuestionSet(makeServes({ architectures: [] }));
      const questions = questionSet.generate(profile);

      const archQuestion = questions.find((q) => q.type === 'architecture');
      expect(archQuestion).toBeUndefined();
    });
  });

  describe('语言问题', () => {
    it('GIVEN 高置信度 (>= 0.9) WHEN generate THEN 不生成语言问题', () => {
      const profile = makeTestProfile({
        targets: [
          {
            id: 'default',
            path: '/test/project',
            language: { value: 'typescript', confidence: 0.95, signals: [] },
            frameworks: [],
            routeKey: 'typescript:*:*',
          },
        ],
      });

      const questionSet = new QuestionSet(makeServes());
      const questions = questionSet.generate(profile);

      const langQuestion = questions.find((q) => q.type === 'language');
      expect(langQuestion).toBeUndefined();
    });

    it('GIVEN 中置信度 (0.6 ~ 0.9) WHEN generate THEN 生成推荐确认语言问题', () => {
      const profile = makeTestProfile({
        targets: [
          {
            id: 'default',
            path: '/test/project',
            language: { value: 'typescript', confidence: 0.75, signals: [] },
            frameworks: [],
            routeKey: 'typescript:*:*',
          },
        ],
      });

      const questionSet = new QuestionSet(makeServes());
      const questions = questionSet.generate(profile);

      const langQuestion = questions.find((q) => q.type === 'language');
      expect(langQuestion).toBeDefined();
      expect(langQuestion?.priority).toBe('recommended');
    });

    it('GIVEN 低置信度 (< 0.6) WHEN generate THEN 生成强制确认语言问题', () => {
      const profile = makeTestProfile({
        targets: [
          {
            id: 'default',
            path: '/test/project',
            language: { value: 'unknown', confidence: 0.4, signals: [] },
            frameworks: [],
            routeKey: 'unknown:*:*',
          },
        ],
      });

      const questionSet = new QuestionSet(makeServes());
      const questions = questionSet.generate(profile);

      const langQuestion = questions.find((q) => q.type === 'language');
      expect(langQuestion).toBeDefined();
      expect(langQuestion?.priority).toBe('required');
    });
  });

  describe('形态问题', () => {
    it('GIVEN 高置信度形态 WHEN generate THEN 不生成形态问题', () => {
      const profile = makeTestProfile({
        targets: [
          {
            id: 'default',
            path: '/test/project',
            language: { value: 'typescript', confidence: 0.95, signals: [] },
            frameworks: [],
            productForm: { value: 'pc', confidence: 0.95, signals: [] },
            routeKey: 'typescript:*:pc',
          },
        ],
      });

      const questionSet = new QuestionSet(makeServes());
      const questions = questionSet.generate(profile);

      const formQuestion = questions.find((q) => q.type === 'form');
      expect(formQuestion).toBeUndefined();
    });

    it('GIVEN 低置信度形态 + 规则库支持 WHEN generate THEN 生成可选确认形态问题', () => {
      const profile = makeTestProfile({
        targets: [
          {
            id: 'default',
            path: '/test/project',
            language: { value: 'typescript', confidence: 0.95, signals: [] },
            frameworks: [],
            productForm: { value: 'pc', confidence: 0.5, signals: [] },
            routeKey: 'typescript:*:pc',
          },
        ],
      });

      const questionSet = new QuestionSet(makeServes());
      const questions = questionSet.generate(profile);

      const formQuestion = questions.find((q) => q.type === 'form');
      expect(formQuestion).toBeDefined();
      expect(formQuestion?.priority).toBe('optional');
    });

    it('GIVEN 规则库不支持当前形态 WHEN generate THEN 不生成形态问题', () => {
      const profile = makeTestProfile({
        targets: [
          {
            id: 'default',
            path: '/test/project',
            language: { value: 'typescript', confidence: 0.95, signals: [] },
            frameworks: [],
            productForm: { value: 'pc', confidence: 0.5, signals: [] },
            routeKey: 'typescript:*:pc',
          },
        ],
      });

      // 规则库不支持 pc
      const questionSet = new QuestionSet(makeServes({ productForms: ['website', 'admin'] }));
      const questions = questionSet.generate(profile);

      const formQuestion = questions.find((q) => q.type === 'form');
      expect(formQuestion).toBeUndefined();
    });

    it('GIVEN 无形态信号 WHEN generate THEN 不生成形态问题', () => {
      const profile = makeTestProfile({
        targets: [
          {
            id: 'default',
            path: '/test/project',
            language: { value: 'typescript', confidence: 0.95, signals: [] },
            frameworks: [],
            routeKey: 'typescript:*:*',
          },
        ],
      });

      const questionSet = new QuestionSet(makeServes());
      const questions = questionSet.generate(profile);

      const formQuestion = questions.find((q) => q.type === 'form');
      expect(formQuestion).toBeUndefined();
    });
  });

  describe('优先级排序', () => {
    it('GIVEN 多个问题 WHEN generate THEN 按优先级排序', () => {
      const profile = makeTestProfile({
        architecture: { value: 'monolith', confidence: 0.5, signals: [] },
        targets: [
          {
            id: 'default',
            path: '/test/project',
            language: { value: 'unknown', confidence: 0.4, signals: [] },
            frameworks: [],
            productForm: { value: 'pc', confidence: 0.5, signals: [] },
            routeKey: 'unknown:*:pc',
          },
        ],
        lastConfirmedAt: undefined,
      });

      const questionSet = new QuestionSet(makeServes());
      const questions = questionSet.generate(profile);

      // 检查排序：required < recommended < optional
      const priorityOrder = { required: 0, recommended: 1, optional: 2 };
      for (let i = 1; i < questions.length; i++) {
        const prev = priorityOrder[questions[i - 1].priority];
        const curr = priorityOrder[questions[i].priority];
        expect(prev).toBeLessThanOrEqual(curr);
      }
    });
  });

  describe('needsConfirmation', () => {
    it('GIVEN 有 required 问题 WHEN needsConfirmation THEN 返回 true', () => {
      const profile = makeTestProfile({
        lastConfirmedAt: undefined,
      });

      const questionSet = new QuestionSet(makeServes());
      const needs = questionSet.needsConfirmation(profile);

      expect(needs).toBe(true);
    });

    it('GIVEN 无 required 问题 WHEN needsConfirmation THEN 返回 false', () => {
      const profile = makeTestProfile({
        architecture: { value: 'monolith', confidence: 0.8, signals: [] },
        targets: [
          {
            id: 'default',
            path: '/test/project',
            language: { value: 'typescript', confidence: 0.95, signals: [] },
            frameworks: [],
            routeKey: 'typescript:*:*',
          },
        ],
        lastConfirmedAt: '2026-08-17T00:00:00.000Z',
      });

      const questionSet = new QuestionSet(makeServes());
      const needs = questionSet.needsConfirmation(profile);

      expect(needs).toBe(false);
    });
  });

  describe('getRequiredQuestions', () => {
    it('GIVEN 混合优先级问题 WHEN getRequiredQuestions THEN 只返回 required', () => {
      const profile = makeTestProfile({
        architecture: { value: 'monolith', confidence: 0.5, signals: [] },
        targets: [
          {
            id: 'default',
            path: '/test/project',
            language: { value: 'typescript', confidence: 0.75, signals: [] },
            frameworks: [],
            productForm: { value: 'pc', confidence: 0.5, signals: [] },
            routeKey: 'typescript:*:pc',
          },
        ],
        lastConfirmedAt: undefined,
      });

      const questionSet = new QuestionSet(makeServes());
      const required = questionSet.getRequiredQuestions(profile);

      // 只有架构问题是 required
      expect(required.length).toBe(1);
      expect(required[0].type).toBe('architecture');
    });
  });

  describe('默认 serves', () => {
    it('GIVEN createDefaultServes() WHEN generate THEN 支持所有语言和形态', () => {
      const serves = createDefaultServes();

      expect(serves.languages.length).toBeGreaterThan(5);
      expect(serves.productForms.length).toBeGreaterThan(5);
      expect(serves.architectures.length).toBe(3);
    });
  });
});
