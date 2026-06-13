import path from "node:path";
import { realpath } from "node:fs/promises";

/**
 * Canonicalize a candidate path relative to workspaceRoot and determine
 * whether it escapes the workspace (path traversal / symlink escape guard).
 *
 * Algorithm:
 *   1. Resolve the real path of workspaceRoot itself.
 *   2. Build the absolute form of candidate.
 *   3. Resolve the real path of its *parent* directory (catches symlinks that
 *      would redirect the directory outside the workspace).  If the parent does
 *      not exist yet, fall back to the un-resolved parent (creation paths).
 *   4. Reconstruct the full path by joining real-parent + basename.
 *   5. Compute path.relative(rootReal, resolved).  An empty relative means
 *      the candidate IS the root; a relative that starts with ".." or is
 *      absolute means it escaped.
 *
 * @param {string} workspaceRoot  - absolute path to the workspace root
 * @param {string} candidate      - path to check (may be relative or absolute)
 * @returns {Promise<{rootReal: string, absolute: string, relative: string, outside: boolean}>}
 */
export async function canonicalWorkspacePath(workspaceRoot, candidate) {
  const rootReal = await realpath(workspaceRoot);
  const absolute = path.resolve(workspaceRoot, candidate);
  const parentReal = await realpath(path.dirname(absolute)).catch(
    () => path.dirname(absolute)
  );
  const resolved = path.join(parentReal, path.basename(absolute));
  const rel = path.relative(rootReal, resolved);
  const outside = rel === "" ? false : rel.startsWith("..") || path.isAbsolute(rel);
  return { rootReal, absolute: resolved, relative: rel, outside };
}
