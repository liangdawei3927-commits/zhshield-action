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
