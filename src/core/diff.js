import { readFile, readdir, stat, readlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { sha256 } from "./hash.js";
import { git, isGitRepo } from "./git.js";

// Directories never walked by the filesystem snapshot: VCS internals, caches,
// and dependency trees. Walking these would be slow and would pollute the diff
// with churn unrelated to the agent's change.
//
// NOTE: build outputs (dist/build/.next) are intentionally NOT skipped. A
// committed bundle is the code that actually ships, so it must be reviewable.
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".adversarial-review",
  "coverage",
  ".cache",
  ".venv",
  "__pycache__",
]);

// ---------------------------------------------------------------------------
// Baseline capture
// ---------------------------------------------------------------------------

// Capture the "before" state of the workspace so a later buildReviewDiff() can
// compute what changed. Git repos record HEAD; non-git workspaces record a full
// content snapshot (see snapshotWorkspace) so the gate cannot be bypassed by
// simply not using git.
export async function captureBaseline(cwd) {
  if (await isGitRepo(cwd)) {
    const head = await git(["rev-parse", "HEAD"], cwd);
    return { type: "git", head: head.stdout.trim() || null, cwd };
  }
  const { files, truncated } = await snapshotWorkspace(cwd);
  return {
    type: "filesystem",
    cwd,
    capturedAt: Date.now(),
    // Serialize the Map to a plain object so the baseline is JSON-persistable
    // by later tasks (the wrapper writes baselines to disk between turns).
    snapshot: Object.fromEntries(files),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Filesystem snapshot
// ---------------------------------------------------------------------------

/**
 * Walk the directory tree under `cwd` and return a content snapshot.
 *
 * @param {string} cwd
 * @param {object} [options]
 * @param {number} [options.maxFileBytes=1000000] - per-file read cap.
 * @param {number} [options.maxFiles=20000] - global file-count guard.
 * @returns {Promise<{ files: Map<string, {hash:string,size:number,binary:boolean,symlink?:boolean}>, truncated: boolean }>}
 *
 * Paths are relative to `cwd` and POSIX-normalized. The change-detection `hash`
 * is ALWAYS computed from a file's actual content via a streaming sha256 (so
 * memory stays bounded for huge/binary files); the `maxFileBytes` cap only
 * limits how much content is later inlined into the diff TEXT, never hashing.
 * Symlinks are recorded by their target (without being followed) so a repointed
 * link is detected as a change.
 */
export async function snapshotWorkspace(cwd, options = {}) {
  const maxFileBytes = options.maxFileBytes || 1_000_000;
  const maxFiles = options.maxFiles || 20_000;
  const files = new Map();
  let truncated = false;

  // Iterative stack walk to avoid deep recursion on large trees.
  const stack = [cwd];
  while (stack.length > 0) {
    if (files.size >= maxFiles) {
      truncated = true;
      break;
    }
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, race): skip it.
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(absolute);
        continue;
      }
      // Symlinks: record the target (without following) so repointing a link is
      // detected. Do NOT recurse into or read through the link, which would risk
      // escaping the workspace or hanging on a cyclic/dangling target.
      if (entry.isSymbolicLink()) {
        if (files.size >= maxFiles) {
          truncated = true;
          break;
        }
        const rel = toPosixRel(cwd, absolute);
        files.set(rel, await snapshotSymlink(absolute, rel));
        continue;
      }
      // Treat remaining non-regular files (FIFOs, devices, sockets) as
      // non-reviewable: skip to avoid hanging.
      if (!entry.isFile()) continue;
      if (files.size >= maxFiles) {
        truncated = true;
        break;
      }
      const rel = toPosixRel(cwd, absolute);
      files.set(rel, await snapshotFile(absolute, rel, maxFileBytes));
    }
  }

  return { files, truncated };
}

// Snapshot a single regular file. The change-detection `hash` is ALWAYS the
// streaming sha256 of the file's full content (any size, text or binary) so a
// same-size content edit can never be missed. `binary` (NUL byte in the first
// chunk) and `size` are tracked separately. The `maxFileBytes` cap is NOT used
// here; it only bounds how much content is later inlined into the diff text.
async function snapshotFile(absolute, rel, maxFileBytes) {
  let size = 0;
  try {
    const info = await stat(absolute);
    size = info.size;
  } catch {
    // File vanished between readdir and stat: record it as an empty entry so a
    // later snapshot that finds it present registers a change.
    return { hash: sha256(`${rel}:0`), size: 0, binary: false };
  }

  try {
    const { hash, binary } = await streamHashAndProbe(absolute);
    return { hash, size, binary };
  } catch {
    // Unreadable content (permissions, race): fall back to a metadata hash so
    // at least a size change is still detected rather than dropping the file.
    return { hash: sha256(`${rel}:${size}`), size, binary: true };
  }
}

// Snapshot a symlink by hashing its target string (without following it). A
// changed target yields a different hash -> reported as modified.
async function snapshotSymlink(absolute, rel) {
  let target = "";
  try {
    target = await readlink(absolute);
  } catch {
    // Dangling/unreadable link: still record an entry so it is reviewable.
    target = "";
  }
  return { symlink: true, size: 0, binary: false, hash: sha256(`symlink:${target}`) };
}

// Stream a file through sha256 while probing the first chunk for a NUL byte
// (binary heuristic). Memory stays bounded regardless of file size because the
// content is consumed chunk-by-chunk and never fully buffered.
function streamHashAndProbe(absolute) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let binary = false;
    let probed = false;
    const stream = createReadStream(absolute);
    stream.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!probed) {
        probed = true;
        binary = bufferHasNul(buf);
      }
      hash.update(buf);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ hash: hash.digest("hex"), binary }));
  });
}

// Binary heuristic: a NUL byte in the inspected prefix marks the file binary.
function bufferHasNul(buf) {
  const limit = Math.min(buf.length, 8000);
  for (let i = 0; i < limit; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// Normalize an absolute path to a POSIX-style path relative to `cwd`.
function toPosixRel(cwd, absolute) {
  return path.relative(cwd, absolute).split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Review diff
// ---------------------------------------------------------------------------

// Build the authoritative "what changed since baseline" diff. Git repos use
// git plumbing; non-git workspaces compare a fresh snapshot against the
// baseline snapshot. INVARIANT: if any file changed, both `text` and
// `changedFiles` are non-empty — never a vacuous empty diff.
export async function buildReviewDiff(cwd, baseline) {
  if (baseline?.type === "git" && baseline.head) {
    const committed = await git(["diff", "--binary", baseline.head, "HEAD"], cwd);
    const working = await git(["diff", "--binary", "HEAD"], cwd);
    const staged = await git(["diff", "--binary", "--cached"], cwd);
    const chunks = [
      withTruncationMarker(committed),
      withTruncationMarker(working),
      withTruncationMarker(staged),
    ];
    // Gather untracked files WITHOUT --exclude-standard so gitignored-but-present
    // runtime files cannot hide from review; SKIP_DIRS filtering keeps
    // node_modules etc. out. This matches the filesystem walk's coverage.
    for (const rel of await gitUntrackedFiles(cwd)) {
      chunks.push(await synthesizeNewFileDiff(cwd, rel));
    }
    const text = chunks.filter(Boolean).join("\n");
    return { text, diffHash: sha256(text), changedFiles: await changedFiles(cwd, baseline) };
  }

  if (baseline?.type === "filesystem") {
    return buildFilesystemReviewDiff(cwd, baseline);
  }

  // Unknown baseline shape: no comparison possible. This is not the bypass case
  // (there is no recorded snapshot to compare against).
  return { text: "", diffHash: sha256(""), changedFiles: [] };
}

// Compute a real diff for non-git workspaces by comparing the current snapshot
// against the baseline snapshot.
async function buildFilesystemReviewDiff(cwd, baseline) {
  const { files: current } = await snapshotWorkspace(cwd, baseline.options || {});
  const baselineSnapshot = baseline.snapshot || {};
  const blocks = [];
  const changed = [];

  const maxFileBytes = (baseline.options && baseline.options.maxFileBytes) || 1_000_000;

  // ADDED + MODIFIED: iterate the current snapshot.
  for (const [rel, info] of current) {
    const prior = baselineSnapshot[rel];
    if (!prior) {
      blocks.push(await addedBlock(cwd, rel, info, maxFileBytes));
      changed.push({ path: rel, status: "A" });
      continue;
    }
    if (prior.hash !== info.hash) {
      blocks.push(await modifiedBlock(cwd, rel, prior, info, maxFileBytes));
      changed.push({ path: rel, status: "M" });
    }
  }

  // DELETED: in baseline but not in the current snapshot.
  for (const rel of Object.keys(baselineSnapshot)) {
    if (!current.has(rel)) {
      blocks.push(deletionBlock(rel));
      changed.push({ path: rel, status: "D" });
    }
  }

  const text = blocks.filter(Boolean).join("\n");
  return { text, diffHash: sha256(text), changedFiles: changed };
}

// ---------------------------------------------------------------------------
// Diff block synthesizers
// ---------------------------------------------------------------------------

// Choose the right block for an ADDED entry based on its kind.
async function addedBlock(cwd, rel, info, maxFileBytes) {
  if (info.symlink) return symlinkBlock(cwd, rel, "new");
  if (info.binary) return binaryMetaBlock(rel, null, info.size, "new");
  return synthesizeNewFileDiff(cwd, rel, maxFileBytes);
}

// Choose the right block for a MODIFIED entry based on its (current) kind.
async function modifiedBlock(cwd, rel, prior, info, maxFileBytes) {
  if (info.symlink || prior.symlink) return symlinkBlock(cwd, rel, "modified");
  if (info.binary || prior.binary) return binaryMetaBlock(rel, prior.size, info.size, "modified");
  return synthesizeModifiedFileDiff(cwd, rel, maxFileBytes);
}

// Synthesize a unified-diff-style block for a brand-new file (used for git
// untracked files and filesystem ADDED text files). The inlined content is
// capped at `maxFileBytes`; the file is still fully hashed elsewhere, so this
// truncation is a diff-text coverage limitation only, marked explicitly.
export async function synthesizeNewFileDiff(cwd, rel, maxFileBytes = 1_000_000) {
  const absolute = path.resolve(cwd, rel);
  const body = await readFile(absolute, "utf8").catch(() => "");
  if (!body) {
    return `diff --git a/${rel} b/${rel}\nnew file mode 100644\nBinary or unreadable file: ${rel}\n`;
  }
  const { text, marker } = capForDiff(body, maxFileBytes);
  const lines = text.split(/\r?\n/).map((line) => `+${line}`).join("\n");
  return `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n${lines}\n${marker}`;
}

// Synthesize a whole-file-replacement block for a MODIFIED text file. A precise
// line-level diff is not required; the block must be clearly marked modified and
// be non-empty so the gate always sees the change. Inlined content is capped.
async function synthesizeModifiedFileDiff(cwd, rel, maxFileBytes = 1_000_000) {
  const absolute = path.resolve(cwd, rel);
  const body = await readFile(absolute, "utf8").catch(() => "");
  const { text, marker } = capForDiff(body, maxFileBytes);
  const lines = text.split(/\r?\n/).map((line) => `+${line}`).join("\n");
  return `diff --git a/${rel} b/${rel}\nmodified file mode 100644\n--- a/${rel}\n+++ b/${rel}\n${lines}\n${marker}`;
}

// Cap inlined diff content at `maxFileBytes`. Returns the (possibly truncated)
// text plus an explicit marker line noting how many bytes were withheld — this
// is a diff-text coverage limitation, not a missed change (the full file is
// always hashed for change detection).
function capForDiff(body, maxFileBytes) {
  const totalBytes = Buffer.byteLength(body, "utf8");
  if (totalBytes <= maxFileBytes) return { text: body, marker: "" };
  // Slice on the byte buffer to honor the cap, then decode back to a string.
  const truncated = Buffer.from(body, "utf8").subarray(0, maxFileBytes).toString("utf8");
  const notShown = totalBytes - Buffer.byteLength(truncated, "utf8");
  const marker =
    `... [truncated: ${notShown} bytes not shown] ...\n` +
    `(coverage limitation: diff text capped at ${maxFileBytes} bytes; full content was hashed for change detection)\n`;
  return { text: truncated, marker };
}

// Small text block for an added/modified symlink, noting its target.
async function symlinkBlock(cwd, rel, kind) {
  const absolute = path.resolve(cwd, rel);
  let target = "";
  try {
    target = await readlink(absolute);
  } catch {
    target = "<unreadable>";
  }
  const mode = kind === "new" ? "new file mode 120000" : "modified file mode 120000";
  return `diff --git a/${rel} b/${rel}\n${mode}\nSymlink ${kind}: ${rel} -> ${target}\n`;
}

// Metadata-only block for a binary file (added or modified). Non-empty by
// construction so binary changes are never silently dropped.
function binaryMetaBlock(rel, oldSize, newSize, kind) {
  const mode = kind === "new" ? "new file mode 100644" : "modified file mode 100644";
  const sizeLine =
    oldSize === null
      ? `Binary file added: size ${newSize} bytes`
      : `Binary file ${kind}: size ${oldSize} -> ${newSize} bytes`;
  return `diff --git a/${rel} b/${rel}\n${mode}\nBinary files a/${rel} and b/${rel} differ\n${sizeLine}\n`;
}

// Deletion marker block for a removed file.
function deletionBlock(rel) {
  return `diff --git a/${rel} b/${rel}\ndeleted file mode 100644\n--- a/${rel}\n+++ /dev/null\n`;
}

// ---------------------------------------------------------------------------
// Changed file list (git)
// ---------------------------------------------------------------------------

// Build the list of changed files for a git baseline by unioning name-status
// across committed / working / staged ranges plus untracked files. Renames
// (status R) contribute both the old and new path entries.
export async function changedFiles(cwd, baseline) {
  const map = new Map(); // path -> status (first writer wins ordering, last status wins)

  const ranges = [
    ["diff", "--name-status", baseline.head, "HEAD"],
    ["diff", "--name-status", "HEAD"],
    ["diff", "--cached", "--name-status"],
  ];
  for (const args of ranges) {
    const result = await git(args, cwd);
    if (result.code !== 0) continue;
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
      parseNameStatusLine(line, map);
    }
  }

  // Gather untracked files WITHOUT --exclude-standard (then SKIP_DIRS-filter) so
  // gitignored-but-present files are still surfaced as additions.
  for (const rel of await gitUntrackedFiles(cwd)) {
    map.set(toPosixSlashes(rel), "A");
  }

  return [...map.entries()].map(([p, status]) => ({ path: p, status }));
}

// List untracked files via git, INCLUDING ignored-but-present ones (no
// --exclude-standard), then drop any path that lives under a SKIP_DIRS segment
// (e.g. node_modules) so the review still ignores dependency/cache trees.
async function gitUntrackedFiles(cwd) {
  const result = await git(["ls-files", "--others"], cwd);
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(toPosixSlashes)
    .filter((rel) => !isUnderSkipDir(rel));
}

// True if any path segment of `rel` is in SKIP_DIRS.
function isUnderSkipDir(rel) {
  return rel.split("/").some((segment) => SKIP_DIRS.has(segment));
}

// If a git() result was truncated by the stdout cap, append an explicit coverage
// limitation marker so the gate treats it as a limitation rather than dropping
// the tail silently. Returns the (possibly annotated) stdout string.
function withTruncationMarker(result) {
  if (!result || !result.truncated) return result ? result.stdout : "";
  return (
    `${result.stdout}\n` +
    `... [git output truncated: exceeded buffer cap; diff is incomplete] ...\n` +
    `(coverage limitation: review this change manually — output was too large to capture in full)\n`
  );
}

// Parse a single `git diff --name-status` line into the path->status map.
// Handles tab-separated columns; rename/copy lines (Rxxx / Cxxx) carry both old
// and new paths and emit two entries.
function parseNameStatusLine(line, map) {
  const parts = line.split("\t");
  const code = parts[0];
  const status = code[0];
  if (status === "R" || status === "C") {
    const oldPath = parts[1];
    const newPath = parts[2];
    if (oldPath) map.set(toPosixSlashes(oldPath), "D");
    if (newPath) map.set(toPosixSlashes(newPath), "A");
    return;
  }
  const target = parts[1];
  if (target) map.set(toPosixSlashes(target), status);
}

function toPosixSlashes(p) {
  return p.split("\\").join("/");
}
