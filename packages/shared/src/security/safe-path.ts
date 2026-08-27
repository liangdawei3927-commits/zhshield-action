import * as fs from 'node:fs';
import path from 'node:path';

/**
 * Thrown when a path computed from untrusted segments escapes the intended
 * base directory (path traversal).
 */
export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

/**
 * Assert that `joined` stays within `resolvedBase` (inclusive of the base
 * itself). Throws {@link PathTraversalError} when the path escapes.
 */
function assertContained(joined: string, resolvedBase: string, base: string): void {
  if (joined !== resolvedBase && !joined.startsWith(resolvedBase + path.sep)) {
    throw new PathTraversalError(
      `Path traversal detected: resolved path "${joined}" escapes base "${base}"`,
    );
  }
}

/**
 * Join `base` with untrusted `segments`, normalizing the result, and assert
 * the result stays within `path.resolve(base)`.
 *
 * For valid (in-bounds) inputs the return value is identical to
 * `path.join(base, ...segments)`, so call sites can be replaced without
 * changing behavior. Throws {@link PathTraversalError} when the joined path
 * escapes the base.
 */
export function safeJoin(base: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(base);
  const joined = path.normalize([resolvedBase, ...segments].join('/'));
  assertContained(joined, resolvedBase, base);
  // Behavior-preserving: identical to path.join(base, ...segments).
  return path.isAbsolute(base) ? joined : path.relative(process.cwd(), joined);
}

/**
 * Resolve untrusted `target` relative to `base`, normalizing the result, and
 * assert the result stays within `path.resolve(base)`.
 *
 * For valid (in-bounds) inputs the return value is identical to
 * `path.resolve(base, target)`. Throws {@link PathTraversalError} when the
 * resolved path escapes the base (including absolute targets outside it).
 */
export function safeResolve(base: string, target: string): string {
  const resolvedBase = path.resolve(base);
  // path.resolve treats an absolute target as absolute (ignoring base), so
  // mirror that here before the containment check.
  const resolved = path.isAbsolute(target)
    ? path.normalize(target)
    : path.normalize([resolvedBase, target].join('/'));
  assertContained(resolved, resolvedBase, base);
  return resolved;
}

/**
 * Resolve the realpath of the nearest EXISTING ancestor of `p` (walking up).
 * Returns null if no existing ancestor is found (reached filesystem root).
 * Used to detect symlink escapes without requiring `p` itself to exist.
 */
function realpathPrefix(p: string): string | null {
  let cur = p;
  // cap iterations to avoid pathological loops
  for (let i = 0; i < 100; i++) {
    try {
      return fs.realpathSync(cur);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null; // reached root
      cur = parent;
    }
  }
  return null;
}

/**
 * Like {@link safeJoin} but ALSO verifies (via fs.realpathSync on the existing
 * path prefix) that no symlink in the resolved path escapes `base`. Use this
 * when `base` may contain untrusted symlinks (e.g. scanning an untrusted repo),
 * where `existsSync`/`statSync`/`readdirSync` would otherwise follow a symlink
 * outside `base`. For in-bounds, non-symlinked inputs the return value is
 * identical to {@link safeJoin}. When the path (or its base) does not exist yet,
 * the realpath check is skipped and only the lexical containment applies.
 */
export function safeJoinReal(base: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(base);
  const joined = path.normalize([resolvedBase, ...segments].join('/'));
  assertContained(joined, resolvedBase, base); // lexical check first
  const baseReal = realpathPrefix(resolvedBase);
  const joinedReal = realpathPrefix(joined);
  if (joinedReal !== null) {
    const anchor = baseReal ?? resolvedBase;
    if (joinedReal !== anchor && !joinedReal.startsWith(anchor + path.sep)) {
      throw new PathTraversalError(
        `Symlink escape detected: resolved path "${joined}" (realpath "${joinedReal}") escapes base "${base}"`,
      );
    }
  }
  return path.isAbsolute(base) ? joined : path.relative(process.cwd(), joined);
}
