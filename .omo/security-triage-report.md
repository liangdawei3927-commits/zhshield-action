# Security-Scan Triage Report

**Source:** Guard report `guard.block.external.security-scan` (semgrep-style SAST)
**Report file:** `/tmp/dump2.log`
**Project:** `/Users/dawei/Desktop/ZHCodeShield/zhiyan-codeshield`
**Date:** 2026-08-27
**Scope:** Analysis only — no source code modified.

---

## 1. Summary

The Guard security-scan reported **149 violations** (message: "扫描器发现 149 个问题"). This report reconciles to **exactly 149 findings** — the count matches the scanner's own total, so no findings are missing or duplicated.

### 1.1 Vulnerability class → total → real-source

| # | Vulnerability Class | Total | Real-Source | Fixture/Sample | Script |
|---|---------------------|-------|-------------|----------------|--------|
| 1 | Path Traversal (`path.join`/`path.resolve` with untrusted input) | 130 | 118 | 8 | 4 |
| 2 | ReDoS (`new RegExp(...)` from dynamic source) | 5 | 5 | 0 | 0 |
| 3 | Log Injection (`util.format`/`console.log` with non-literal format) | 5 | 5 | 0 | 0 |
| 4 | Command Injection (`child_process` from function arg) | 2 | 2 | 0 | 0 |
| 5 | `shell: true` in `child_process` spawn | 1 | 1 | 0 | 0 |
| 6 | `eval()` usage | 1 | 0 | 1 | 0 |
| 7 | Hardcoded AWS Access Key | 1 | 0 | 1 | 0 |
| 8 | Hardcoded Generic API Key | 1 | 0 | 1 | 0 |
| 9 | CORS `Access-Control-Allow-Origin: *` | 1 | 1 | 0 | 0 |
| 10 | GCM auth-tag length not specified (`createDecipheriv`) | 1 | 1 | 0 | 0 |
| 11 | `String.replace` with non-global string pattern (escape bypass) | 1 | 1 | 0 | 0 |
| | **TOTAL** | **149** | **134** | **11** | **4** |

**Reconciliation:** 134 (real-source) + 11 (fixture/sample) + 4 (script) = **149** ✓

### 1.2 Disposition definitions

- **REAL-SOURCE** — under `packages/*/src`, not fixtures/tests/scripts. Actionable production code.
- **FIXTURE/SAMPLE** — under `**/fixtures/**` or `**/__tests__/**` (test data, sample/evil fixtures, test assertions). Not shipped; low priority.
- **SCRIPT** — under `packages/*/scripts/**` (build/dev tooling). Not shipped to runtime; low priority.

---

## 2. Detailed Findings

Each finding is listed as `file:line` → message (abridged) → class → disposition.

### 2.1 Path Traversal (130)

Untrusted input flowing into `path.join` / `path.resolve`. **118 real-source, 8 fixture/sample, 4 script.**

**REAL-SOURCE (118):**

| file:line | Class | Disposition |
|-----------|-------|-------------|
| `packages/db/src/connection.ts:84` (×2) | path-traversal | REAL-SOURCE |
| `packages/dependency/src/adapters/env-consistency.ts:278,279,280,323,336,400,405,450,461(×2),573` | path-traversal | REAL-SOURCE |
| `packages/dependency/src/adapters/lockfile-verifier.ts:308,392,593,660,661,662,663,664,667(×2),673` | path-traversal | REAL-SOURCE |
| `packages/dependency/src/adapters/npm-outdated.ts:120` | path-traversal | REAL-SOURCE |
| `packages/dependency/src/adapters/upgrade-evaluator.ts:226,245(×2)` | path-traversal | REAL-SOURCE |
| `packages/dependency/src/graph-builder.ts:107,659,789,790,791,792,793,794,795` | path-traversal | REAL-SOURCE |
| `packages/fingerprint/src/scoring/file-scanner.ts:81(×2),104(×2)` | path-traversal | REAL-SOURCE |
| `packages/fingerprint/src/scoring/profiler.ts:59(×2),96` | path-traversal | REAL-SOURCE |
| `packages/guard/src/config-loader.ts:21` | path-traversal | REAL-SOURCE |
| `packages/inspect/src/ai-code/files.ts:62(×2),88(×2),91(×2),220,232(×2)` | path-traversal | REAL-SOURCE |
| `packages/kernel/src/config.ts:79,83(×2)` | path-traversal | REAL-SOURCE |
| `packages/kernel/src/file.ts:28(×2)` | path-traversal | REAL-SOURCE |
| `packages/performance/src/adapters/bundle-size-detector.ts:59,104(×2)` | path-traversal | REAL-SOURCE |
| `packages/performance/src/adapters/tree-shaking-detector.ts:94,95,205(×2),230(×2),232(×2),236(×2),244` | path-traversal | REAL-SOURCE |
| `packages/performance/src/engine.ts:21(×2)` | path-traversal | REAL-SOURCE |
| `packages/refactor/src/engine.ts:194(×2),270(×2)` | path-traversal | REAL-SOURCE |
| `packages/security/src/garbage-scanner.ts:50(×2),109,125(×2),133,136(×2),154,155(×2),166(×2),172(×2)` | path-traversal | REAL-SOURCE |
| `packages/security/src/malware-scanner.ts:108(×2)` | path-traversal | REAL-SOURCE |
| `packages/security/src/npm-threat-scanner.ts:138,139` | path-traversal | REAL-SOURCE |
| `packages/security/src/pypi-threat-scanner.ts:144,148,152` | path-traversal | REAL-SOURCE |
| `packages/sentinel/src/file-monitor.ts:104(×2),140(×2),144(×2)` | path-traversal | REAL-SOURCE |
| `packages/sentinel/src/project-probe.ts:35,57(×2),66` | path-traversal | REAL-SOURCE |
| `packages/sentinel/src/stack-locator.ts:134(×2),143(×2),193(×2)` | path-traversal | REAL-SOURCE |
| `packages/server/src/sentinel/sentinel.service.ts:31` | path-traversal | REAL-SOURCE |

**FIXTURE/SAMPLE (8):**

| file:line | Class | Disposition |
|-----------|-------|-------------|
| `packages/fingerprint/src/__tests__/scoring-profile.test.ts:10` | path-traversal | FIXTURE/SAMPLE |
| `packages/sentinel/src/__tests__/log-collector.test.ts:13,14,15,17,19,29,33` | path-traversal | FIXTURE/SAMPLE |

**SCRIPT (4):**

| file:line | Class | Disposition |
|-----------|-------|-------------|
| `packages/kernel/scripts/copy-sop-rules.cjs:16(×2),18(×2)` | path-traversal | SCRIPT |

### 2.2 ReDoS (5) — all REAL-SOURCE

`RegExp()` built from a function argument (dynamic source) — blocks the main thread.

| file:line | Message (arg) | Class | Disposition |
|-----------|---------------|-------|-------------|
| `packages/dependency/src/adapters/typosquat-detector.ts:215` | `RegExp()` with `packageName` arg | redos | REAL-SOURCE |
| `packages/dependency/src/adapters/upgrade-evaluator.ts:229` | `RegExp()` with `patterns` arg | redos | REAL-SOURCE |
| `packages/kernel/src/runner/scan-utils.ts:74` | `RegExp()` with `patternStr` arg | redos | REAL-SOURCE |
| `packages/kernel/src/runner/scan-utils.ts:133` | `RegExp()` with `layers` arg | redos | REAL-SOURCE |
| `packages/shared/src/scope-matcher.ts:56` | `RegExp()` with `glob` arg | redos | REAL-SOURCE |

### 2.3 Log Injection (5) — all REAL-SOURCE

Non-literal variable in `util.format` / `console.log` format string.

| file:line | Class | Disposition |
|-----------|-------|-------------|
| `packages/desktop/electron/ipc/ai-tools.ts:167` | log-injection | REAL-SOURCE |
| `packages/kernel/src/bus.ts:47` | log-injection | REAL-SOURCE |
| `packages/kernel/src/sop/_meta/sop-loader.ts:208` | log-injection | REAL-SOURCE |
| `packages/sentinel/src/file-monitor.ts:110` | log-injection | REAL-SOURCE |
| `packages/server/src/sop/tool-rule-loader.ts:115` | log-injection | REAL-SOURCE |

### 2.4 Command Injection (2) — all REAL-SOURCE

`child_process` called from a function argument `action`.

| file:line | Class | Disposition |
|-----------|-------|-------------|
| `packages/sentinel/src/auto-fixer.ts:34` | command-injection | REAL-SOURCE |
| `packages/sentinel/src/auto-fixer.ts:72` | command-injection | REAL-SOURCE |

### 2.5 Other classes (1 each)

| file:line | Message | Class | Disposition |
|-----------|---------|-------|-------------|
| `packages/sentinel/src/process-monitor.ts:102` | `$SPAWN` with `{shell: true}` | shell-true | REAL-SOURCE |
| `packages/server/src/main.ts:45` | `Access-Control-Allow-Origin: *` | cors | REAL-SOURCE |
| `packages/kernel/src/sop/security/sop-signer.ts:206` | `createDecipheriv` GCM missing auth-tag length | gcm-tag | REAL-SOURCE |
| `packages/kernel/src/file.ts:32` | `pattern.replace('*', ...)` first-occurrence-only | replace-first | REAL-SOURCE |
| `packages/security/src/__tests__/fixtures/conflict-resolver/evil.ts:1` | `eval()` | eval | FIXTURE/SAMPLE |
| `packages/security/src/__tests__/secrets.test.ts:76` | AWS Access Key hardcoded | aws-key | FIXTURE/SAMPLE |
| `packages/security/src/__tests__/secrets.test.ts:74` | Generic API Key hardcoded | api-key | FIXTURE/SAMPLE |

---

## 3. Fix Recommendations per Class

### 3.1 Path Traversal (130 — highest priority)

**Problem:** Untrusted input (file names, package names, glob results, config values) flows into `path.join`/`path.resolve`, then into `fs` read/write. An attacker controlling a segment can escape the intended base directory and read/write arbitrary files.

**Fix pattern — validate + normalize + confine to an allowlisted base:**

```ts
import * as path from 'path';

const BASE_DIR = path.resolve(process.cwd(), 'data');

/** Resolve a user-supplied relative path, guaranteeing it stays inside BASE_DIR. */
function safeResolve(userPath: string): string {
  // 1. Reject absolute paths and any '..' traversal outright.
  if (path.isAbsolute(userPath)) {
    throw new Error('Absolute paths are not allowed');
  }
  // 2. Normalize to strip '.', '..', and duplicate separators.
  const normalized = path.normalize(userPath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.includes(`..${path.sep}`)) {
    throw new Error('Path traversal is not allowed');
  }
  // 3. Resolve against the allowlisted base and assert containment.
  const resolved = path.resolve(BASE_DIR, normalized);
  const rel = path.relative(BASE_DIR, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Resolved path escapes the allowed base directory');
  }
  return resolved;
}

// Usage:
const filePath = safeResolve(userProvidedName);
const data = fs.readFileSync(filePath, 'utf-8');
```

**Alternative (preferred when the base is fixed):** use `path.resolve(base, path.relative(base, target))` then assert the result stays within `base`:

```ts
function confine(base: string, target: string): string {
  const resolved = path.resolve(base, target);
  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes base');
  }
  return resolved;
}
```

**Notes for this codebase:**
- Many hits are `path.join(dir, entry.name)` from `fs.readdirSync` (e.g. `garbage-scanner.ts:50`, `file.ts:28`). These are lower risk because `entry.name` comes from the OS directory listing, but the scanner flags them because `dir` may be user-controlled. Apply `confine()` at the entry point where `dir`/`projectPath` is first accepted.
- `packages/dependency/src/adapters/lockfile-verifier.ts` and `graph-builder.ts` join package/registry paths — validate package names against a safe charset (`/^[a-z0-9._-]+$/i`) before joining.
- `packages/kernel/src/config.ts:79,83` — validate config-supplied paths against the project root.

### 3.2 ReDoS (5)

**Problem:** `new RegExp(...)` / `RegExp(...)` built from a runtime function argument (glob patterns, package names, layer names, scan patterns). A malicious pattern can cause catastrophic backtracking and block the main thread.

**Fix pattern — never build RegExp from runtime input; use a hardcoded allowlist or validate against a constant safe charset:**

```ts
// BAD: dynamic regex from user/glob input
const re = new RegExp(`^${userPattern}$`);

// GOOD: hardcoded literal patterns only
const SAFE_PATTERNS: ReadonlyArray<RegExp> = [
  /^[a-z0-9._-]+$/i,   // package name
  /^\/[a-z0-9/_-]+$/i, // layer path
];

// If you MUST accept a pattern, validate it is a safe literal (no quantifiers/backrefs)
// and bound its length, then escape all metacharacters:
function toSafeLiteralRegex(input: string): RegExp {
  if (input.length > 128) throw new Error('Pattern too long');
  const escaped = input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`);
}
```

**Notes for this codebase:**
- `packages/shared/src/scope-matcher.ts:56` — `globToRegExp` builds a regex from a glob string. Prefer a dedicated glob library (e.g. `picomatch`/`minimatch`) that is ReDoS-hardened, or bound pattern length and escape metacharacters.
- `packages/kernel/src/runner/scan-utils.ts:74` — `new RegExp(patternStr, 'g')` where `patternStr` comes from SOP rule config. Validate patterns at load time against a safe charset and reject quantifier-heavy patterns.
- `packages/dependency/src/adapters/typosquat-detector.ts:215` — building a regex from `packageName`; escape the name before interpolation.

### 3.3 Log Injection (5)

**Problem:** A non-literal variable is used as the format string in `util.format`/`console.log`. If an attacker injects a format specifier (`%s`, `%d`, `%o`), they can forge log messages or leak data.

**Fix pattern — constant message templates + structured fields (escape/newline-strip untrusted values):**

```ts
// BAD: untrusted value used as the format string
console.error(`[EventBus] Error in listener for "${event}":`, err);

// GOOD: constant template; untrusted values passed as arguments, never as the format
console.error('[EventBus] Error in listener for "%s": %O', sanitize(event), err);

// Structured logging with constant template + sanitized fields:
function sanitizeField(v: unknown): string {
  return String(v).replace(/[\r\n]/g, ' ').slice(0, 512);
}
logger.error({ msg: 'listener_error', event: sanitizeField(event), err });
```

**Notes for this codebase:**
- `packages/kernel/src/bus.ts:47` — `event` is interpolated into the template. Use a constant template and pass `event` as an argument.
- `packages/sentinel/src/file-monitor.ts:110`, `packages/server/src/sop/tool-rule-loader.ts:115`, `packages/desktop/electron/ipc/ai-tools.ts:167`, `packages/kernel/src/sop/_meta/sop-loader.ts:208` — same pattern: constant template + sanitized argument.

### 3.4 Command Injection (2) + `shell: true` (1)

**Problem:** `execSync`/`spawn` invoked with a string built from a function argument (`action.params.process`, `action.params.script`), and one `spawn` with `{shell: true}`. If the argument is user-controllable, arbitrary commands can run.

**Fix pattern — avoid shell; use `execFile`/`spawn` with an argument array and no shell:**

```ts
import { execFileSync, spawn } from 'child_process';

// BAD: string interpolation into a shell command
execSync(`npm run ${processName}`, { shell: true });

// GOOD: no shell, arguments passed as an array
execFileSync('npm', ['run', processName], { cwd, timeout: 10000, stdio: 'pipe' });

// For spawn, never use shell:true; pass args as an array
const child = spawn('npm', ['run', processName], { cwd, shell: false });

// Validate the command name against an allowlist
const ALLOWED_SCRIPTS = new Set(['dev', 'build', 'test', 'start']);
if (!ALLOWED_SCRIPTS.has(processName)) throw new Error('Disallowed script');
```

**Notes for this codebase:**
- `packages/sentinel/src/auto-fixer.ts:34` — `npm run ${processName}` → use `execFileSync('npm', ['run', processName], ...)` and validate `processName` against an allowlist.
- `packages/sentinel/src/auto-fixer.ts:72` — `execSync(script, ...)` where `script` is `action.params.script`. Replace with `execFileSync` + arg array, or reject if it contains shell metacharacters.
- `packages/sentinel/src/process-monitor.ts:102` — set `shell: false` and pass args as an array.

### 3.5 CORS `Access-Control-Allow-Origin: *` (1)

**Problem:** `packages/server/src/main.ts:45` sets `Access-Control-Allow-Origin: *`, disabling Same-Origin Policy.

**Fix:** restrict to an explicit allowlist of origins (or reflect the request origin only after validation):

```ts
const ALLOWED_ORIGINS = new Set(['https://app.example.com']);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  next();
});
```

### 3.6 GCM auth-tag length not specified (1)

**Problem:** `packages/kernel/src/sop/security/sop-signer.ts:206` calls `createDecipheriv` with GCM but does not specify `authTagLength`. A shorter-than-expected tag could be accepted, enabling forgery.

**Fix:** pass the expected `authTagLength` (16 bytes for AES-GCM) and always verify the tag:

```ts
const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
decipher.setAuthTag(tag); // must be set before final()
const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
```

### 3.7 `String.replace` first-occurrence-only (1)

**Problem:** `packages/kernel/src/file.ts:32` uses `pattern.replace('*', '')` — a string pattern replaces only the first `*`, so a glob with multiple `*` is not fully stripped, potentially bypassing an escape/sanitization.

**Fix:** use a global regex or `replaceAll`:

```ts
// BAD: only first '*' removed
entry.name.includes(pattern.replace('*', ''));

// GOOD: remove all occurrences
entry.name.includes(pattern.replace(/\*/g, ''));
// or
entry.name.includes(pattern.replaceAll('*', ''));
```

### 3.8 Fixture/Sample findings (eval, aws-key, api-key, 8 path-traversal in tests)

These are **test fixtures and test assertions** — `evil.ts` is an intentional malicious sample, `secrets.test.ts` asserts detection of hardcoded keys, and the test files exercise path handling. **No production fix required.** Optionally add them to a SAST ignore/allowlist so they don't pollute the real-source signal.

---

## 4. Prioritized Remediation Order

| Priority | Class | Count (real-source) | Rationale |
|----------|-------|---------------------|-----------|
| **P0** | Path Traversal | 118 | Arbitrary file read/write; broadest attack surface; most findings. Fix entry points where user/package/config input first enters `path.join`/`path.resolve`. |
| **P1** | Command Injection + `shell: true` | 3 | Remote code execution if args are user-controllable. |
| **P1** | ReDoS | 5 | DoS on the main thread; easy to fix (escape/allowlist). |
| **P2** | GCM auth-tag | 1 | Crypto forgery risk; trivial fix. |
| **P2** | CORS `*` | 1 | Cross-origin data exposure; trivial fix. |
| **P2** | Log Injection | 5 | Log forgery / data leakage; low effort. |
| **P3** | `replace` first-only | 1 | Escape bypass; low severity. |
| **P3** | Fixture/Sample (eval, keys, test path-traversal) | 11 | Not shipped; add to SAST allowlist. |
| **P3** | Script path-traversal | 4 | Dev tooling only; not shipped. |

**Recommended first actions:**
1. Add a shared `safeResolve(base, target)` / `confine()` helper (e.g. in `packages/shared/src`) and route all `path.join`/`path.resolve` call sites through it — this addresses the 118 real-source path-traversal findings at once.
2. Replace `execSync`/`spawn` string commands with `execFileSync`/arg-array + `shell:false` in `auto-fixer.ts` and `process-monitor.ts`.
3. Escape/allowlist all dynamic `RegExp` sources in `scope-matcher.ts`, `scan-utils.ts`, `typosquat-detector.ts`, `upgrade-evaluator.ts`.
4. Add the fixture/test findings to the SAST allowlist to keep the real-source signal clean.

---

*Report generated from `/tmp/dump2.log` GuardReport. Total findings: 149 (reconciled). No source files were modified.*
