import { readFile, readdir, stat, lstat, readlink, open } from "node:fs/promises";
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
  // MCP `spec-workflow` scaffolding (templates/specs written into the workspace at
  // SessionStart). On a NON-git workspace these are written AFTER the baseline snapshot,
  // so they read as permanently-"added" in every diff and the gate blocks EVERY Stop
  // (even no-op turns). They are tool-generated noise, not the agent's reviewable code.
  ".spec-workflow",
]);

// A directory whose name is a Python VIRTUALENV. These hold installed third-party
// packages (like node_modules) — not the user's reviewable code — and can be ENORMOUS
// (a torch install is >1 GB). SKIP_DIRS lists only the literal ".venv", but real
// projects use variant names (".venv-mcp", "venv311", "virtualenv"), none of which
// matched — so the ENTIRE tree was synthesized into the diff and could overflow V8's
// ~512 MiB max string length (RangeError → buildReviewDiff throws → the gate reads
// diff===null and fails closed EVERY turn).
//
// PRECISION (a too-broad match is a fail-OPEN: skipping a real source dir hides code
// from review). A DOTTED ".venv*" name is, by universal convention, a virtualenv, so we
// match it broadly (optional version digits or a "-_."-separated suffix: ".venv-mcp",
// ".venv311", ".venv.bak"). A NON-dotted name is only matched when it is unambiguous —
// exactly "venv", "venv"+digits ("venv311"), or "virtualenv" — so plausible SOURCE
// directories like "venv-api", "venv_src", "virtualenv.config" are NOT skipped (they
// fall through to the total-diff byte budget instead, which fails CLOSED, never open).
// Does NOT match "venvironment", ".venvironment", "env", "myvenv".
const VENV_DIR_RE = /^(?:\.venv(?:\d+|[-_.].*)?|venv\d*|\.?virtualenv)$/;

/**
 * Build the effective skip-dir set: the built-in SKIP_DIRS plus any TRUSTED extra dir
 * names (from runtime.extraSkipDirs — user/global config only; load-config pins the whole
 * runtime block to the trusted baseline, so a cloned/untrusted PROJECT cannot add a skip
 * dir to hide code, a fail-open). Each extra is validated to a single safe path SEGMENT
 * (non-empty, no separators, not "."/".."), so it can only ever match a directory name.
 *
 * @param {string[]} [extraSkipDirs]
 * @returns {Set<string>}
 */
function resolveSkipSet(extraSkipDirs) {
  if (!Array.isArray(extraSkipDirs) || extraSkipDirs.length === 0) return SKIP_DIRS;
  const set = new Set(SKIP_DIRS);
  for (const raw of extraSkipDirs) {
    if (typeof raw !== "string") continue;
    const seg = raw.trim();
    if (!seg || seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\")) continue;
    set.add(seg);
  }
  return set;
}

/** Whether a single path SEGMENT (a directory name) should be skipped from review. */
function isSkipSegment(name, skipSet = SKIP_DIRS) {
  return skipSet.has(name) || VENV_DIR_RE.test(name);
}

// Hard ceiling on the TOTAL bytes of synthesized/joined diff text. Set well under V8's
// ~512 MiB max string length so the final join() can NEVER throw RangeError, and a sane
// upper bound on "too large to meaningfully review". A change set that exceeds this
// degrades to the coverage-limitation sentinel (the gate forces manual review / fails
// closed with a CLEAR message) instead of crashing buildReviewDiff (which read as
// diff===null → "repository corrupted"). Defense-in-depth for ANY pathological large
// untracked/added tree, not just a virtualenv that slipped the skip list.
const MAX_TOTAL_DIFF_BYTES = 128 * 1024 * 1024; // 128 MiB

// ---------------------------------------------------------------------------
// Baseline capture
// ---------------------------------------------------------------------------

function normalizeBaselineScope(scope) {
  // Backward compatibility: the original API accepted extraSkipDirs directly.
  if (Array.isArray(scope)) {
    return { extraSkipDirs: scope, respectGitignore: false };
  }
  const input = scope && typeof scope === "object" ? scope : {};
  return {
    extraSkipDirs: Array.isArray(input.extraSkipDirs) ? input.extraSkipDirs : [],
    // New captures use the product default. Explicit malformed values fall back
    // to exhaustive review rather than silently narrowing coverage.
    respectGitignore:
      input.respectGitignore === undefined ? true : input.respectGitignore === true,
  };
}

function baselineRespectsGitignore(baseline) {
  // Persisted baselines from before this option existed remain exhaustive.
  return baseline?.respectGitignore === true;
}

// Capture the "before" state of the workspace so a later buildReviewDiff() can
// compute what changed. Git repos record HEAD; non-git workspaces record a full
// content snapshot (see snapshotWorkspace) so the gate cannot be bypassed by
// simply not using git.
export async function captureBaseline(cwd, scope) {
  // RECORD the trusted extra-skip-dir list IN the baseline so buildReviewDiff later uses
  // the SAME skip set for the current snapshot/untracked walk — keeping the baseline and
  // the diff consistent even if config is re-read between SessionStart and Stop.
  const { extraSkipDirs: extra, respectGitignore } = normalizeBaselineScope(scope);
  const gitRepo = await isGitRepo(cwd);
  if (gitRepo) {
    const head = await git(["rev-parse", "HEAD"], cwd);
    const headSha = head.stdout.trim();
    // A git repo with at least one commit: diff against the committed HEAD tree.
    // NB: on a zero-commit (unborn) branch, `git rev-parse HEAD` ECHOES the
    // literal "HEAD" to stdout (with an error on stderr + nonzero exit), so we
    // must require a real 40-char object id — not just any non-empty stdout —
    // before trusting the git path.
    if (/^[0-9a-f]{40}$/i.test(headSha)) {
      return { type: "git", head: headSha, cwd, extraSkipDirs: extra, respectGitignore };
    }
    // A git repo with NO commits (no HEAD) has no committed tree to diff against.
    // Fall through to the FILESYSTEM snapshot so every working-tree file is still
    // captured and reviewed — otherwise a zero-commit repo would make ALL files
    // invisible to the gate (a full bypass).
  }
  const snapshotSource = gitRepo && respectGitignore ? "git-files" : "filesystem-walk";
  const { files, truncated } =
    snapshotSource === "git-files"
      ? await snapshotGitFiles(cwd, { extraSkipDirs: extra })
      : await snapshotWorkspace(cwd, { extraSkipDirs: extra });
  return {
    type: "filesystem",
    cwd,
    capturedAt: Date.now(),
    // Serialize the Map to a plain object so the baseline is JSON-persistable
    // by later tasks (the wrapper writes baselines to disk between turns).
    snapshot: Object.fromEntries(files),
    truncated,
    extraSkipDirs: extra,
    respectGitignore,
    snapshotSource,
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
  const skipSet = resolveSkipSet(options.extraSkipDirs);
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
        if (isSkipSegment(entry.name, skipSet)) continue;
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

// Snapshot the file set Git considers tracked or non-ignored untracked. This is
// used for unborn/zero-commit repositories so ignored trees are never walked.
async function snapshotGitFiles(cwd, options = {}) {
  const maxFileBytes = options.maxFileBytes || 1_000_000;
  const maxFiles = options.maxFiles || 20_000;
  const skipSet = resolveSkipSet(options.extraSkipDirs);
  const result = await git(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    cwd
  );
  if (result.code !== 0 || result.truncated) {
    throw new Error(`git_snapshot_listing_failed:${result.code ?? "truncated"}`);
  }

  const paths = [...new Set(
    result.stdout
      .split("\0")
      .filter(Boolean)
      .map(toPosixSlashes)
      .filter((rel) => !path.isAbsolute(rel) && !rel.startsWith("../"))
      .filter((rel) => !isUnderSkipDir(rel, skipSet))
  )].sort();
  const files = new Map();
  let truncated = paths.length > maxFiles;

  for (const rel of paths.slice(0, maxFiles)) {
    const absolute = path.resolve(cwd, rel);
    let info;
    try {
      info = await lstat(absolute);
    } catch {
      // A tracked path may currently be deleted; omitting it lets the normal
      // baseline comparison report deletion when it existed previously.
      continue;
    }
    if (info.isSymbolicLink()) {
      files.set(rel, await snapshotSymlink(absolute, rel));
    } else if (info.isFile()) {
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
export async function buildReviewDiff(cwd, baseline, options = {}) {
  // The total-diff byte budget is overridable (tests pass a tiny value to exercise the
  // truncation path without synthesizing 128 MiB); production callers omit it.
  const maxTotalDiffBytes =
    Number.isFinite(options.maxTotalDiffBytes) && options.maxTotalDiffBytes > 0
      ? options.maxTotalDiffBytes
      : MAX_TOTAL_DIFF_BYTES;
  // Use the SAME skip set the baseline was captured with (recorded in the baseline) so
  // the current snapshot/untracked walk excludes the same dirs — baseline and diff stay
  // consistent (a dir excluded at capture is excluded now, so it never shows as deleted).
  const skipSet = resolveSkipSet(baseline?.extraSkipDirs);
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
    // Enumerate once and reuse this exact list for both synthesized diff blocks
    // and changedFiles coverage so the two views can never diverge.
    const untrackedFiles = await gitUntrackedFiles(
      cwd,
      skipSet,
      baselineRespectsGitignore(baseline)
    );
    // Accumulate under a TOTAL byte budget so a pathological untracked tree (e.g. a huge
    // virtualenv that slipped the skip list, or a model cache) can never overflow V8's
    // max string length on join() — over budget we STOP synthesizing (bounding memory
    // too) and emit the coverage-limitation sentinel so the gate fails closed clearly.
    let totalBytes = chunks.reduce((n, c) => n + (c ? Buffer.byteLength(c, "utf8") + 1 : 0), 0);
    // Initialize from the BASE chunks too: if the committed/working/staged diffs alone
    // already exceed the budget (and there are no untracked files to trip the loop), the
    // sentinel must still fire. (audit: budget only checked inside the untracked loop.)
    let budgetTruncated = totalBytes > maxTotalDiffBytes;
    for (const rel of untrackedFiles) {
      if (totalBytes > maxTotalDiffBytes) {
        budgetTruncated = true;
        break;
      }
      const block = await synthesizeNewFileDiff(cwd, rel);
      if (block) {
        chunks.push(block);
        totalBytes += Buffer.byteLength(block, "utf8") + 1;
      }
    }
    if (budgetTruncated) chunks.push(totalDiffTruncationBlock("untracked files", maxTotalDiffBytes));
    const text = chunks.filter(Boolean).join("\n");
    const changed = await changedFiles(cwd, baseline, { untrackedFiles });
    if (budgetTruncated && !changed.some((c) => c.path === TRUNCATION_SENTINEL_PATH)) {
      changed.push({ path: TRUNCATION_SENTINEL_PATH, status: "M" });
    }
    return { text, diffHash: sha256(text), changedFiles: changed };
  }

  if (baseline?.type === "filesystem") {
    return buildFilesystemReviewDiff(cwd, baseline, maxTotalDiffBytes);
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
async function buildFilesystemReviewDiff(cwd, baseline, maxTotalDiffBytes = MAX_TOTAL_DIFF_BYTES) {
  // Snapshot the CURRENT tree with the SAME extra-skip-dir set the baseline was captured
  // with, so an excluded dir is excluded in both and never shows as spuriously deleted.
  const snapshotOptions = {
    ...(baseline.options || {}),
    extraSkipDirs: baseline.extraSkipDirs,
  };
  const { files: current, truncated: currentTruncated } =
    baseline.snapshotSource === "git-files"
      ? await snapshotGitFiles(cwd, snapshotOptions)
      : await snapshotWorkspace(cwd, snapshotOptions);
  const baselineSnapshot = baseline.snapshot || {};
  const blocks = [];
  const changed = [];

  const maxFileBytes = (baseline.options && baseline.options.maxFileBytes) || 1_000_000;

  // ADDED + MODIFIED: iterate the current snapshot, under the SAME total byte budget as
  // the git path so a pathological change set can never overflow V8's max string length
  // on join(). Over budget we stop synthesizing blocks and emit the sentinel below.
  let totalBytes = 0;
  let budgetTruncated = false;
  for (const [rel, info] of current) {
    if (totalBytes > maxTotalDiffBytes) {
      budgetTruncated = true;
      break;
    }
    const prior = baselineSnapshot[rel];
    if (!prior) {
      const b = await addedBlock(cwd, rel, info, maxFileBytes);
      blocks.push(b);
      totalBytes += b ? Buffer.byteLength(b, "utf8") + 1 : 0;
      changed.push({ path: rel, status: "A" });
      continue;
    }
    if (prior.hash !== info.hash) {
      const b = await modifiedBlock(cwd, rel, prior, info, maxFileBytes);
      blocks.push(b);
      totalBytes += b ? Buffer.byteLength(b, "utf8") + 1 : 0;
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

  // Total-diff byte-budget overflow (a pathological change set): surface the same
  // coverage-limitation sentinel so the gate fails closed rather than crashing on join.
  if (budgetTruncated) {
    blocks.unshift(totalDiffTruncationBlock("changed files", maxTotalDiffBytes));
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

// Coverage-limitation block emitted when the TOTAL synthesized diff hit
// MAX_TOTAL_DIFF_BYTES (e.g. a huge untracked/added tree). Non-empty + uses the
// reviewable sentinel path so the gate forces manual review instead of crashing with a
// RangeError on an over-long join(). (bug: a large non-.venv virtualenv overflowed the
// join, making the gate fail closed every turn with a misleading "repository corrupted".)
function totalDiffTruncationBlock(what, capBytes = MAX_TOTAL_DIFF_BYTES) {
  const human = capBytes >= 1024 * 1024 ? `${Math.round(capBytes / (1024 * 1024))} MiB` : `${capBytes} bytes`;
  return (
    `diff --git a/${TRUNCATION_SENTINEL_PATH} b/${TRUNCATION_SENTINEL_PATH}\n` +
    `coverage limitation: the synthesized diff for ${what} exceeded the ${human} total ` +
    `cap, so it was truncated and may be missing real changes — review this change set ` +
    `manually and exclude large generated/dependency trees (e.g. a virtualenv or model ` +
    `cache) from the workspace so the diff is complete.\n`
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
  // Read at most maxFileBytes+1 bytes (NOT the whole file): a multi-GB untracked text
  // file would otherwise be fully loaded by readFile AND re-buffered by the cap, OOM-
  // crashing the gate before the per-file cap could apply. A read error (missing /
  // permission / not a regular file) yields a clearly-flagged non-empty block; an empty
  // file ("") still renders as a valid empty added file. (audit / GPT-5.5-xhigh)
  const capped = await readCappedUtf8(absolute, maxFileBytes);
  if (capped === null) {
    return `diff --git a/${rel} b/${rel}\nnew file mode 100644\nBinary or unreadable file: ${rel}\n`;
  }
  const lines = renderAddedLines(capped.text);
  const marker = capped.overCap ? capMarker(maxFileBytes, capped.totalBytes) : "";
  return `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n${lines}\n${marker}`;
}

// Synthesize a whole-file-replacement block for a MODIFIED text file. A precise
// line-level diff is not required; the block must be clearly marked modified and
// be non-empty so the gate always sees the change. Inlined content is capped.
async function synthesizeModifiedFileDiff(cwd, rel, maxFileBytes = 1_000_000) {
  const absolute = path.resolve(cwd, rel);
  // Bounded read (see synthesizeNewFileDiff): never load the whole (possibly huge) file.
  // On a read failure emit a clearly-flagged NON-EMPTY block instead of silently
  // producing empty content — an empty "modified" block would let a changed-but-
  // unreadable file pass with nothing for the reviewer to see (a fail-open).
  const capped = await readCappedUtf8(absolute, maxFileBytes);
  if (capped === null) {
    return `diff --git a/${rel} b/${rel}\nmodified file mode 100644\nBinary or unreadable file: ${rel}\n`;
  }
  const lines = renderAddedLines(capped.text);
  const marker = capped.overCap ? capMarker(maxFileBytes, capped.totalBytes) : "";
  return `diff --git a/${rel} b/${rel}\nmodified file mode 100644\n--- a/${rel}\n+++ b/${rel}\n${lines}\n${marker}`;
}

// Read at most `maxFileBytes`+1 bytes of a file as utf8 WITHOUT buffering the whole
// file. The +1 lets us tell whether the file EXCEEDS the cap (overCap). `totalBytes` is
// the file's full size (from fstat) for the truncation marker. Returns null on any read
// error or a non-regular file. Memory stays bounded regardless of file size, so a huge
// untracked text file can no longer OOM the gate before the cap applies. (audit:
// synthesize* previously readFile()'d the entire file, then re-buffered it in the cap.)
async function readCappedUtf8(absolute, maxFileBytes) {
  let fh;
  try {
    fh = await open(absolute, "r");
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const want = maxFileBytes + 1;
    const buf = Buffer.alloc(want);
    let bytesRead = 0;
    // Loop to tolerate short reads (POSIX read() may return fewer bytes than requested).
    while (bytesRead < want) {
      const r = await fh.read(buf, bytesRead, want - bytesRead, bytesRead);
      if (r.bytesRead === 0) break; // EOF
      bytesRead += r.bytesRead;
    }
    const overCap = bytesRead > maxFileBytes;
    const keep = buf.subarray(0, Math.min(bytesRead, maxFileBytes));
    return { text: keep.toString("utf8"), overCap, totalBytes: st.size };
  } catch {
    return null;
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// Marker appended when a file's inlined diff text was capped at `maxFileBytes`. It MUST
// contain the exact "coverage limitation: diff text capped at" substring that gate.js
// keys on (TRUNCATION_MARKER) to fail closed on a truncated reviewable file. The full
// content is still HASHED for change detection, so this is a diff-text coverage
// limitation, not a missed change.
function capMarker(maxFileBytes, totalBytes) {
  const notShown = Math.max(0, (Number(totalBytes) || 0) - maxFileBytes);
  return (
    `... [truncated: ${notShown} bytes not shown] ...\n` +
    `(coverage limitation: diff text capped at ${maxFileBytes} bytes; full content was hashed for change detection)\n`
  );
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
export async function changedFiles(cwd, baseline, options = {}) {
  const map = new Map(); // path -> status (first writer wins ordering, last status wins)
  const skipSet = resolveSkipSet(baseline?.extraSkipDirs);

  // `-z`: NUL-delimit the output so a path containing a newline/tab is parsed intact.
  // Without it, splitting on newlines breaks a file like `src/evil\n.js` into fake
  // paths, hiding its real content from review (a fail-OPEN). (audit / GPT-5.5-xhigh)
  const ranges = [
    ["diff", "--name-status", "-z", baseline.head, "HEAD"],
    ["diff", "--name-status", "-z", "HEAD"],
    ["diff", "--cached", "--name-status", "-z"],
  ];
  for (const args of ranges) {
    const result = await git(args, cwd);
    if (result.code !== 0) continue;
    parseNameStatusZ(result.stdout, map);
  }

  const untrackedFiles = Array.isArray(options.untrackedFiles)
    ? options.untrackedFiles
    : await gitUntrackedFiles(cwd, skipSet, baselineRespectsGitignore(baseline));
  for (const rel of untrackedFiles) {
    map.set(toPosixSlashes(rel), "A");
  }

  return [...map.entries()].map(([p, status]) => ({ path: p, status }));
}

// List untracked files via Git, optionally honoring standard ignore sources,
// then apply the gate's built-in/trusted directory exclusions.
async function gitUntrackedFiles(cwd, skipSet = SKIP_DIRS, respectGitignore = false) {
  // `-z`: NUL-delimit so a filename containing a newline stays one path (splitting on
  // newlines would break it into fake paths whose real content is then never reviewed —
  // a fail-OPEN). (audit / GPT-5.5-xhigh)
  const args = ["ls-files", "-z", "--others"];
  if (respectGitignore) args.push("--exclude-standard");
  const result = await git(args, cwd);
  if (result.code !== 0 || result.truncated) {
    throw new Error(`git_untracked_listing_failed:${result.code ?? "truncated"}`);
  }
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map(toPosixSlashes)
    .filter((rel) => !isUnderSkipDir(rel, skipSet));
}

// True if any PARENT path segment of `rel` is a skip dir.
function isUnderSkipDir(rel, skipSet = SKIP_DIRS) {
  // Only PARENT segments (directories) gate skipping: a FILE whose basename merely
  // matches a skip name (e.g. a real source file literally named "venv.py" or
  // "node_modules") must still be REVIEWED — skipping it on a basename match would be a
  // fail-OPEN. So check every segment EXCEPT the last (the file's basename).
  const segments = rel.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    if (isSkipSegment(segments[i], skipSet)) return true;
  }
  return false;
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

// Parse NUL-delimited `git diff --name-status -z` output into the path->status map.
// Verified format: each change is `<status>\0<path>\0`; a rename/copy is
// `<status>\0<oldpath>\0<newpath>\0` (the status token, e.g. "R100", precedes its 1 or 2
// path tokens). NUL-delimiting keeps a path that itself contains a newline/tab intact,
// so a file like `src/evil\n.js` can no longer be split into fake paths that hide its
// real content from review (fail-open). A trailing empty token (after the final NUL) is
// skipped.
function parseNameStatusZ(stdout, map) {
  const tokens = String(stdout).split("\0");
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++];
    if (!code) continue; // trailing/empty token
    const status = code[0];
    if (status === "R" || status === "C") {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath) map.set(toPosixSlashes(oldPath), "D");
      if (newPath) map.set(toPosixSlashes(newPath), "A");
    } else {
      const target = tokens[i++];
      if (target) map.set(toPosixSlashes(target), status);
    }
  }
}

function toPosixSlashes(p) {
  return p.split("\\").join("/");
}
