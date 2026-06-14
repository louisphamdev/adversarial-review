import { readFile, readdir, stat, readlink } from "node:fs/promises";
import { createReadStream, realpathSync } from "node:fs";
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
    const headSha = head.stdout.trim();
    // A git repo with at least one commit: diff against the committed HEAD tree.
    // NB: on a zero-commit (unborn) branch, `git rev-parse HEAD` ECHOES the
    // literal "HEAD" to stdout (with an error on stderr + nonzero exit), so we
    // must require a real 40-char object id — not just any non-empty stdout —
    // before trusting the git path.
    if (/^[0-9a-f]{40}$/i.test(headSha)) return { type: "git", head: headSha, cwd };
    // A git repo with NO commits (no HEAD) has no committed tree to diff against.
    // Fall through to the FILESYSTEM snapshot so every working-tree file is still
    // captured and reviewed — otherwise a zero-commit repo would make ALL files
    // invisible to the gate (a full bypass).
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

  // Canonical workspace root used for the directory-containment check below.
  // realpathSync collapses junctions / symlinked parents so the comparison is
  // against the TRUE root, not an aliased path. If the root itself cannot be
  // resolved (race/permission) fall back to the literal cwd.
  let realRoot;
  try {
    realRoot = realpathSync(cwd);
  } catch {
    realRoot = cwd;
  }

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
      // Unreadable directory (permissions, race): we CANNOT see its contents, so a
      // change inside it is invisible to the snapshot — a fail-OPEN for the filesystem
      // baseline (a directory made unreadable after baseline capture could hide a
      // malicious edit). Mark the snapshot truncated so buildFilesystemReviewDiff
      // emits the coverage-limitation sentinel and the gate forces review rather than
      // treating the unreadable subtree as "no change". (audit ROUND7 / GPT-5.5)
      truncated = true;
      continue;
    }
    // Sort entries by name so the walk order is deterministic and independent of
    // the underlying filesystem's readdir order. Without this the synthesized
    // diff TEXT (and thus diffHash) varies across runs/OSes for the SAME change
    // set, causing spurious review-cache misses.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // Workspace-escape guard. A directory entry may be a Windows NTFS
        // junction (mklink /J reports isDirectory()=true, isSymbolicLink()=false)
        // or any symlinked/reparse-point directory that slips past the symlink
        // branch on some Node/OS combos. Resolve its REAL path and only recurse
        // when it stays WITHIN the canonical workspace root; otherwise treat the
        // directory as a boundary and do not walk into it (which would read
        // external files into the snapshot and could overflow maxFiles). A dir
        // whose realpath cannot be resolved is also treated as a boundary.
        if (!isWithinRoot(realRoot, absolute)) continue;
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
    // Unreadable content (permissions, race): we cannot hash the real bytes, so the
    // metadata fallback hash is IDENTICAL for two same-size payloads — a same-size
    // content change would be INVISIBLE (a fail-OPEN). Keep the metadata hash (so a
    // SIZE change is still detected) but flag the entry `unreadable` so
    // buildFilesystemReviewDiff surfaces a coverage limitation and forces review
    // rather than trusting "no change" for it. (audit ROUND7 / GPT-5.5)
    return { hash: sha256(`${rel}:${size}`), size, binary: true, unreadable: true };
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

// True iff the REAL path of `dir` is the canonical workspace root or lives
// strictly beneath it. Resolving with realpathSync collapses junctions /
// symlinked directories to their true target so an entry that escapes the
// workspace (NTFS junction to C:\Windows, a symlinked dir to /etc, …) is
// rejected. The prefix test compares against `root + sep` so a sibling whose
// name merely shares the root as a string prefix (e.g. ".../ws-evil" vs
// ".../ws") is NOT mistaken for a child. A path that cannot be resolved is
// treated as NOT contained (fail closed: do not recurse).
function isWithinRoot(root, dir) {
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return false;
  }
  if (real === root) return true;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return real.startsWith(rootWithSep);
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
    // --no-textconv / --no-ext-diff: a committed .gitattributes can bind files to
    // a `textconv`/external diff driver that REPLACES the real content shown to
    // the reviewer (hiding a malicious change). Force the raw diff so an untrusted
    // repo cannot launder its diff through a content filter. (git is already
    // invoked with -c core.quotePath=false for correct non-ASCII paths.)
    const committed = await git(["diff", "--no-textconv", "--no-ext-diff", "--binary", baseline.head, "HEAD"], cwd);
    const working = await git(["diff", "--no-textconv", "--no-ext-diff", "--binary", "HEAD"], cwd);
    const staged = await git(["diff", "--no-textconv", "--no-ext-diff", "--binary", "--cached"], cwd);
    // A `git diff` that exits NON-ZERO is an ERROR, not "no changes" — e.g. a
    // corrupted `.git/index` makes the working-tree / staged diff fail with empty
    // stdout. Returning that empty output would make the gate read a corrupted
    // repo as a clean, change-free workspace (a fail-OPEN). THROW so callers treat
    // it as an unbuildable diff / detection failure and fail closed. (round 6)
    for (const r of [committed, working, staged]) {
      if (r && r.code !== 0) throw new Error(`git_diff_command_failed:${r.code}`);
    }
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

  // A NON-NULL baseline with an UNRECOGNIZED shape (e.g. `{type:"bogus"}`, or a git
  // baseline missing its head) is a CORRUPTED/FORGED baseline, not "no baseline
  // recorded". Returning a vacuous empty diff here would let it read as a clean,
  // change-free workspace (a fail-OPEN) even when the working tree was modified.
  // THROW so evaluateGate's diff===null path fails closed in enforced/strict (the
  // same posture as a corrupted .git/index). A genuinely ABSENT baseline
  // (null/undefined) still returns the empty diff below for the existing no-baseline
  // handling. (audit ROUND7 / GPT-5.5)
  if (baseline != null) {
    throw new Error("unrecognized_baseline_shape");
  }
  return { text: "", diffHash: sha256(""), changedFiles: [] };
}

// Synthetic path used to surface a truncated-snapshot coverage limitation as a
// reviewable changed-file entry so the gate cannot treat an incomplete baseline
// as a clean "no changes" result. It is intentionally extensionless so the
// gate's classifyPath fails CLOSED and marks it reviewable (an extensionless
// path is reviewable, while a `.txt` would be docs-only and slip review).
const TRUNCATION_SENTINEL_PATH = ".adversarial-review-snapshot-truncated";

// Compute a real diff for non-git workspaces by comparing the current snapshot
// against the baseline snapshot.
async function buildFilesystemReviewDiff(cwd, baseline) {
  const { files: current, truncated: currentTruncated } = await snapshotWorkspace(
    cwd,
    baseline.options || {}
  );
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

  // FAIL CLOSED on a truncated snapshot. If EITHER the baseline OR the current
  // snapshot hit the maxFiles cap, the per-file comparison above is unreliable:
  // a file that fell outside the captured window in either walk is invisible to
  // this diff, so a real change can vanish into a vacuously empty diff (a silent
  // bypass). When truncation occurred we ALWAYS emit a coverage-limitation block
  // plus a synthetic reviewable changed-file entry, so the diff is never empty
  // and the gate is forced to treat the change set as needing manual review
  // rather than as "nothing changed".
  // Also treat an UNREADABLE file (content could not be hashed, in EITHER snapshot)
  // as a coverage limitation: a same-size content change to it would be invisible, so
  // it must not pass as "no change". Surface it through the SAME sentinel path.
  // (audit ROUND7 / GPT-5.5)
  const anyUnreadable =
    [...current.values()].some((info) => info && info.unreadable) ||
    Object.values(baselineSnapshot).some((info) => info && info.unreadable);
  if (baseline.truncated || currentTruncated || anyUnreadable) {
    blocks.unshift(truncatedSnapshotBlock(baseline.truncated, currentTruncated || anyUnreadable));
    if (!changed.some((c) => c.path === TRUNCATION_SENTINEL_PATH)) {
      changed.push({ path: TRUNCATION_SENTINEL_PATH, status: "M" });
    }
  }

  const text = blocks.filter(Boolean).join("\n");
  return { text, diffHash: sha256(text), changedFiles: changed };
}

// Coverage-limitation block emitted when a filesystem snapshot was truncated at
// the maxFiles cap. It is intentionally non-empty so the review diff can never
// be a vacuous empty string when the baseline/current comparison is incomplete.
function truncatedSnapshotBlock(baselineTruncated, currentTruncated) {
  const which = baselineTruncated && currentTruncated
    ? "baseline and current"
    : baselineTruncated
      ? "baseline"
      : "current";
  return (
    `diff --git a/${TRUNCATION_SENTINEL_PATH} b/${TRUNCATION_SENTINEL_PATH}\n` +
    `coverage limitation: filesystem snapshot truncated at the maxFiles cap ` +
    `(${which} snapshot incomplete); some files were not compared so this diff ` +
    `may be missing real changes — review this change set manually and reduce ` +
    `the workspace file count (e.g. add SKIP_DIRS entries) so the snapshot is complete.\n`
  );
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
  // Branch on the READ FAILURE, not on `!body`: an empty string ("") is a
  // perfectly valid empty text file and must render as an empty added file, not
  // be misreported as "Binary or unreadable". Only a genuine read error
  // (missing/permission/binary-decode failure) should take the unreadable path.
  let body;
  try {
    body = await readFile(absolute, "utf8");
  } catch {
    return `diff --git a/${rel} b/${rel}\nnew file mode 100644\nBinary or unreadable file: ${rel}\n`;
  }
  const { text, marker } = capForDiff(body, maxFileBytes);
  const lines = renderAddedLines(text);
  return `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n${lines}\n${marker}`;
}

// Synthesize a whole-file-replacement block for a MODIFIED text file. A precise
// line-level diff is not required; the block must be clearly marked modified and
// be non-empty so the gate always sees the change. Inlined content is capped.
async function synthesizeModifiedFileDiff(cwd, rel, maxFileBytes = 1_000_000) {
  const absolute = path.resolve(cwd, rel);
  let body;
  try {
    body = await readFile(absolute, "utf8");
  } catch {
    // On a read failure, emit a clearly-flagged NON-EMPTY block (like the
    // new-file path) instead of silently producing empty content — an empty
    // "modified" block would let a changed-but-unreadable file pass with nothing
    // for the reviewer to see (a fail-open).
    return `diff --git a/${rel} b/${rel}\nmodified file mode 100644\nBinary or unreadable file: ${rel}\n`;
  }
  const { text, marker } = capForDiff(body, maxFileBytes);
  const lines = renderAddedLines(text);
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

/**
 * Render file content as `+`-prefixed unified-diff lines, preserving each line's
 * exact bytes — including a trailing `\r` (CRLF) and any other in-line control
 * characters. Splitting on `\n` only (NOT `/\r?\n/`) keeps the carriage return
 * inside each line, so byte-distinct contents that differ ONLY in line endings
 * (CRLF vs LF) render to DIFFERENT text and therefore hash to different
 * diffHash/payloadHash values. Collapsing `\r?\n` here previously let a CRLF
 * and an LF version of the same logical lines synthesize identical diff text.
 *
 * @param {string} text - the (possibly capped) file body.
 * @returns {string} newline-joined, `+`-prefixed lines.
 */
function renderAddedLines(text) {
  return text.split("\n").map((line) => `+${line}`).join("\n");
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
