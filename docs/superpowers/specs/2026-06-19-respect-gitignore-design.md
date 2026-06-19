# Respect `.gitignore` in Review Scope

Date: 2026-06-19

## Problem

The gate currently enumerates untracked files with:

```text
git ls-files -z --others
```

This deliberately includes ignored files. In ordinary development repositories,
ignored caches, build output, virtual environments, logs, and scratch files can
overwhelm the synthesized diff. The gate then truncates the review scope and
fails closed on every Stop event, making the plugin impractical to keep enabled.

Tracked files remain visible to Git diff even when they match an ignore rule.
The problematic scope is specifically untracked and ignored files.

## Goals

- Make the default review scope usable in normal working trees.
- Continue reviewing tracked changes and non-ignored untracked files.
- Preserve the existing exhaustive filesystem posture for explicitly configured
  untrusted-repository audits.
- Apply one stable scope policy throughout baseline capture and later diff
  construction.
- Disclose when ignored untracked files were omitted.

## Non-goals

- Do not change tracked-file diff semantics.
- Do not make project-controlled configuration capable of narrowing review
  coverage.
- Do not redesign the general include/exclude system.
- Do not infer behavior from policy mode such as `strict-ci`; scope must remain
  explicit and predictable.

## Configuration

Add:

```json
{
  "runtime": {
    "respectGitignore": true
  }
}
```

The default is `true`.

The complete `runtime` block is already pinned to trusted user/global
configuration by `loadEffectiveConfig()`. Therefore a repository's project
configuration cannot set `respectGitignore` to hide files.

Setting the trusted value to `false` restores the existing behavior: all
present untracked files are eligible except paths excluded by built-in or
trusted `extraSkipDirs` rules.

Invalid non-boolean values fall back to the secure exhaustive posture
(`false`). This prevents malformed trusted configuration from silently
narrowing coverage.

## Baseline Contract

`captureBaseline()` accepts a runtime-scope object containing:

- `extraSkipDirs`
- `respectGitignore`

Both normalized values are stored in the baseline. `buildReviewDiff()` and
`changedFiles()` consume the stored values rather than re-reading configuration.
This guarantees SessionStart and Stop use the same scope even if configuration
changes during the session.

Filesystem baselines also record `snapshotSource`:

- `"filesystem-walk"` for genuine non-Git workspaces and exhaustive mode;
- `"git-files"` for a zero-commit Git repository using Git-aware filtering.

The current snapshot uses the recorded source, preventing a zero-commit baseline
from being captured with one scope and compared using another.

For compatibility:

- a newly captured baseline with no scope argument uses the product defaults:
  `extraSkipDirs=[]` and `respectGitignore=true`;
- the legacy positional array form `captureBaseline(cwd, extraSkipDirs)` remains
  accepted and implies `respectGitignore=false`, preserving its historical
  semantics;
- a persisted baseline missing `respectGitignore` means `false`, preserving the
  coverage posture under which that older baseline was captured;
- a persisted filesystem baseline missing `snapshotSource` means
  `"filesystem-walk"`.

CLI callers pass the effective runtime settings when capturing a new baseline.

## Git Baselines

When `respectGitignore` is `true`, enumerate untracked files with:

```text
git ls-files -z --others --exclude-standard
```

When it is `false`, retain:

```text
git ls-files -z --others
```

The same enumeration result feeds both synthesized diff blocks and
`changedFiles`, preventing coverage-list divergence.

Tracked files continue to come from `git diff` and remain reviewable even if a
later `.gitignore` rule matches their path.

## Filesystem Baselines

There are two filesystem-baseline cases:

1. A genuine non-Git workspace.
2. A Git repository without a valid `HEAD`, such as a zero-commit repository.

For a genuine non-Git workspace, `.gitignore` has no authoritative Git meaning,
so the existing filesystem walk remains unchanged.

For a Git repository without `HEAD` and `respectGitignore=true`, baseline and
current snapshots omit ignored paths while retaining tracked and non-ignored
paths. Git provides the authoritative file set:

```text
git ls-files -z --cached --others --exclude-standard
```

The snapshot hashes the present files from this list directly instead of first
walking the entire workspace. This avoids traversing large ignored directory
trees and keeps Git, rather than JavaScript, responsible for ignore semantics.
Listed tracked files that are currently absent are omitted from the current
snapshot so normal baseline comparison reports their deletion.

Ignored filtering must be applied consistently during both baseline and current
snapshot capture. A filtering failure is a detection failure and must not
silently produce a narrowed snapshot.

When `respectGitignore=false`, filesystem snapshot behavior remains exhaustive,
subject to the existing skip-directory and resource-cap safeguards.

## Observability

Diff construction returns scope metadata:

```js
{
  ignoredUntrackedSkipped: number
}
```

The count comes from:

```text
git ls-files -z --others --ignored --exclude-standard
```

Counting is performed only when `respectGitignore=true`. A small Git helper
counts NUL-delimited records while streaming stdout, rather than buffering all
ignored path names in memory.

User-facing CLI and hook paths emit at most one stderr line per review:

```text
adversarial-review: skipped 70818 gitignored untracked file(s) (respectGitignore=true)
```

No message is emitted when the count is zero. The message is diagnostic only
and does not alter verdict payloads or hashes. The authoritative gate evaluation
reports the diagnostic through an optional callback supplied by CLI and hook
entry points; quiescence sampling does not emit it repeatedly.

If obtaining the disclosure count fails but the effective review enumeration
succeeds, review proceeds and omits the count. The count is observability, not
the source of review correctness.

## Security Properties

- A project config cannot enable ignored-file exclusion.
- Tracked ignored files remain covered.
- Non-ignored untracked files remain covered.
- `respectGitignore=false` preserves exhaustive untracked review.
- Older baselines without the setting retain exhaustive behavior.
- Git errors in authoritative scope construction remain fail-closed.
- Resource caps and truncation sentinels remain unchanged.

The default changes the product trade-off toward ordinary developer usability.
Users reviewing untrusted repositories can explicitly set the trusted global
option to `false`.

## Testing

Add regression coverage for:

1. Default config sets `runtime.respectGitignore` to `true`.
2. Project config cannot override the trusted value.
3. Git diff excludes ignored untracked files by default.
4. Non-ignored untracked files remain in diff text and `changedFiles`.
5. Tracked files matching `.gitignore` remain reviewable.
6. Trusted `respectGitignore=false` restores ignored-untracked coverage.
7. Existing baselines without the field preserve exhaustive behavior.
8. Zero-commit Git repositories apply identical ignore filtering to baseline
   and current snapshots.
9. Genuine non-Git workspaces retain the existing filesystem walk.
10. The skipped-count diagnostic is emitted once when nonzero and omitted when
    zero.
11. `extraSkipDirs`, virtualenv filtering, Unicode paths, NUL-delimited parsing,
    truncation, and fail-closed tests continue to pass.

## Documentation

Update the README configuration example and trust-model section to explain:

- the default behavior;
- the trusted user/global-only override;
- when to set `respectGitignore=false`;
- that tracked ignored files are still reviewed.

Add a changelog entry describing the usability fix and the explicit
high-trust-boundary override.
