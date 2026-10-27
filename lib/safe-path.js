import path from 'node:path';

export class PathTraversalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

/**
 * Resolve `segments` against `root` and guarantee the result stays inside
 * `root`. Throws PathTraversalError if the resolved path would escape root
 * — via `..`, an absolute path segment, or any other trick that resolves
 * outside the boundary.
 *
 * This is the only way any file under `root` should ever be read. It does
 * not touch the filesystem itself (no existence check) — callers still need
 * to handle ENOENT for missing files.
 */
export function safeJoin(root, ...segments) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  const rootWithSep = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : resolvedRoot + path.sep;

  if (target !== resolvedRoot && !target.startsWith(rootWithSep)) {
    throw new PathTraversalError(
      `Refusing to read a path outside of ${resolvedRoot}: ${segments.join('/')}`
    );
  }

  return target;
}
