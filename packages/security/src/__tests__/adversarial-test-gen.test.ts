// F4-2 CI integration: adversarial fixtures are generated in-memory from the
// attack-pattern YAML corpus and run through the REAL injection-guard detectors.
// No LLM, no network; disk writes only ever land in an os.tmpdir() sandbox.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateVariants,
  loadAttackPatternsFromSources,
  type GeneratedVariant,
} from '../adversarial-test-gen';
import {
  classifyPackageJsonScripts,
  isEnvFile,
  scanCommentInstructions,
  scanMarkdownHiddenLinks,
} from '../injection-guard';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PATTERN_DIR = path.join(TEST_DIR, 'attack-patterns');
const HANDWRITTEN_FIXTURE_ROOT = path.join(TEST_DIR, 'fixtures', 'injection');
const MIN_VARIANTS_PER_POSITIVE_PATTERN = 5;
const MIN_HIT_RATE = 0.95;

function loadPatternSources(): string[] {
  return fs.readdirSync(PATTERN_DIR)
    .filter((name) => name.endsWith('.yaml'))
    .sort()
    .map((name) => fs.readFileSync(path.join(PATTERN_DIR, name), 'utf-8'));
}

interface DetectionResult {
  hit: boolean;
  finding?: string;
}

function detectVariant(variant: GeneratedVariant): DetectionResult {
  switch (variant.targetDetector) {
    case 'scanCommentInstructions': {
      const hits = scanCommentInstructions(variant.content, variant.fileExt);
      return { hit: hits.length > 0, finding: hits[0]?.matchedPattern };
    }
    case 'classifyPackageJsonScripts': {
      const suspicious = classifyPackageJsonScripts(variant.content).find((v) => v.verdict === 'suspicious');
      return { hit: suspicious !== undefined, finding: suspicious?.matchedPattern };
    }
    case 'scanMarkdownHiddenLinks': {
      const hits = scanMarkdownHiddenLinks(variant.content);
      return { hit: hits.length > 0, finding: hits[0]?.kind };
    }
    case 'isEnvFile':
      return { hit: isEnvFile(variant.fileName) };
  }
}

function requireVariant(group: readonly GeneratedVariant[], planDescription: string): GeneratedVariant {
  const found = group.find((v) => v.planDescription === planDescription);
  if (found === undefined) throw new Error(`missing variant with plan '${planDescription}'`);
  return found;
}

function snapshotTree(root: string): Array<[string, number]> {
  const entries: Array<[string, number]> = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else entries.push([path.relative(root, full), fs.statSync(full).size]);
    }
  };
  visit(root);
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

const sources = loadPatternSources();
const patterns = loadAttackPatternsFromSources(sources);
const variants = generateVariants(patterns);

describe('F4-1 attack-pattern corpus', () => {
  it('loads the full YAML corpus with positives and negative controls', () => {
    expect(patterns).toHaveLength(9);
    expect(patterns.filter((p) => p.expectedHit)).toHaveLength(5);
    expect(patterns.filter((p) => !p.expectedHit)).toHaveLength(4);
  });

  it('covers all four landed injection categories', () => {
    const categories = [...new Set(patterns.map((p) => p.category))].sort();
    expect(categories).toEqual(['prompt-injection', 'secret-exfiltration', 'supply-chain', 'ui-redress']);
  });

  it('rejects malformed patterns instead of guessing', () => {
    expect(() => loadAttackPatternsFromSources(['patternId: only-id'])).toThrow(/description/);
    expect(() => loadAttackPatternsFromSources([
      'patternId: x\ndescription: d\ncategory: supply-chain\ntargetDetector: classifyPackageJsonScripts\nexpectedHit: true\n',
    ])).toThrow(/baseTemplate/);
    expect(() => loadAttackPatternsFromSources([
      'patternId: x\ndescription: d\ncategory: supply-chain\ntargetDetector: classifyPackageJsonScripts\nexpectedHit: true\nbaseTemplate: t\nlocalDiversifiers:\n  - type: contextPrefix\n    preset: benign-doc-lines\n',
    ])).toThrow(/benign-doc-lines/);
  });
});

describe('F4 adversarial generator', () => {
  it('produces >=N variants per positive pattern with real diversification', () => {
    for (const pattern of patterns.filter((p) => p.expectedHit)) {
      const group = variants.filter((v) => v.patternId === pattern.patternId);
      expect(
        group.length,
        `${pattern.patternId} produced only ${group.length} variants`,
      ).toBeGreaterThanOrEqual(MIN_VARIANTS_PER_POSITIVE_PATTERN);

      const baseline = requireVariant(group, 'baseline');
      for (const variant of group) {
        if (variant.planDescription === 'baseline') continue;
        const differs = variant.content !== baseline.content || variant.fileName !== baseline.fileName;
        expect(differs, `${variant.variantLabel} is identical to baseline`).toBe(true);
      }
    }
  });

  it('combined local+global plans differ from their local-only parent', () => {
    for (const pattern of patterns) {
      if (pattern.localDiversifiers.length === 0 || pattern.globalDiversifiers.length === 0) continue;
      const group = variants.filter((v) => v.patternId === pattern.patternId);
      const localType = pattern.localDiversifiers[0]?.type ?? '';
      const globalType = pattern.globalDiversifiers[0]?.type ?? '';
      const localOnly = requireVariant(group, localType);
      const combined = requireVariant(group, `${localType}+${globalType}`);
      expect(combined.content, `${pattern.patternId}: combined plan collapsed onto local-only`).not.toBe(localOnly.content);
    }
  });

  it('is deterministic across runs (pure function, no hidden state)', () => {
    const rerun = generateVariants(loadAttackPatternsFromSources(sources));
    expect(JSON.stringify(rerun)).toBe(JSON.stringify(variants));
  });
});

describe('F4-2 hit-rate stability against real injection-guard detectors', () => {
  it('hits >=95% of positive variants', () => {
    const positives = variants.filter((v) => v.expectHit);
    const missed = positives.filter((v) => !detectVariant(v).hit);
    const rate = (positives.length - missed.length) / positives.length;
    expect(
      rate,
      `hit rate ${(rate * 100).toFixed(1)}% — missed: ${missed.map((m) => m.variantLabel).join(', ')}`,
    ).toBeGreaterThanOrEqual(MIN_HIT_RATE);
  });

  it('reports the expected finding name on every declared positive hit', () => {
    for (const variant of variants.filter((v) => v.expectHit && v.expectedFinding !== undefined)) {
      const result = detectVariant(variant);
      if (!result.hit) continue;
      expect(result.finding, variant.variantLabel).toBe(variant.expectedFinding);
    }
  });

  it('keeps the false-positive rate of negative controls at exactly 0', () => {
    const negatives = variants.filter((v) => !v.expectHit);
    expect(negatives.length).toBeGreaterThanOrEqual(10);
    const flagged = negatives.filter((v) => detectVariant(v).hit);
    expect(
      flagged,
      `false positives: ${flagged.map((f) => f.variantLabel).join(', ')}`,
    ).toEqual([]);
  });
});

describe('fixture hygiene', () => {
  it('writes generated output only to a temp dir, never into the src tree', () => {
    const before = JSON.stringify(snapshotTree(HANDWRITTEN_FIXTURE_ROOT));
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-adversarial-'));
    try {
      for (const variant of variants) {
        const target = path.join(tmpRoot, variant.variantLabel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, variant.content, 'utf-8');
      }
      expect(snapshotTree(tmpRoot)).toHaveLength(variants.length);
      expect(JSON.stringify(snapshotTree(HANDWRITTEN_FIXTURE_ROOT))).toBe(before);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
