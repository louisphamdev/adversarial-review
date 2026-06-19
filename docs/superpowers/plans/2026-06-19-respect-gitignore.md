# Respect `.gitignore` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make normal reviews exclude ignored untracked files by default while preserving an explicit trusted exhaustive-review mode.

**Architecture:** Store a normalized review-scope policy in every new baseline. Git baselines enumerate untracked files once and reuse that exact result for diff text and coverage; zero-commit Git repositories snapshot the file set reported by Git rather than walking ignored trees. Gate entry points receive one optional scope diagnostic without changing verdict hashes.

**Tech Stack:** Node.js 20+, ES modules, `node:test`, Git plumbing, PowerShell-compatible npm scripts.

---

## File Map

- Modify `src/core/config.js`: add the trusted runtime default.
- Modify `src/core/git.js`: add a streaming NUL-record counter for ignored-file diagnostics.
- Modify `src/core/diff.js`: normalize baseline scope, add Git-aware snapshots, enumerate untracked files once, and return scope metadata.
- Modify `src/core/gate.js`: emit one optional scope diagnostic from the authoritative diff build.
- Modify `src/cli/hook.js`, `src/cli/run.js`, `src/cli/check.js`: pass runtime scope at baseline capture and write diagnostics to stderr.
- Modify `test/core/config.test.js`, `test/core/load-config.test.js`: cover default and project trust boundaries.
- Modify `test/core/diff.test.js`: cover Git, legacy-baseline, zero-commit, and non-Git behavior.
- Modify `test/core/gate.test.js`: cover one-shot diagnostic delivery.
- Modify `test/cli/hook.test.js`, `test/cli/run.test.js`, `test/cli/check.test.js`: cover user-visible stderr wiring where practical.
- Modify `README.md`, `CHANGELOG.md`: document behavior and migration.

### Task 1: Configuration and Baseline Scope Contract

**Files:**
- Modify: `test/core/config.test.js`
- Modify: `test/core/load-config.test.js`
- Modify: `test/core/edit-scope-and-skip.test.js`
- Modify: `src/core/config.js`
- Modify: `src/core/diff.js`
- Modify: `src/cli/hook.js`
- Modify: `src/cli/run.js`
- Modify: `src/cli/check.js`

- [ ] **Step 1: Write failing config and baseline-contract tests**

Add assertions equivalent to:

```js
test("default runtime respects gitignore", () => {
  assert.equal(mergeConfig().runtime.respectGitignore, true);
});

it("project cannot override trusted runtime.respectGitignore", async () => {
  await writeJson(join(home, CONFIG_REL), { runtime: { respectGitignore: false } });
  await writeJson(join(cwd, CONFIG_REL), { runtime: { respectGitignore: true } });
  const cfg = await loadEffectiveConfig(cwd, io());
  assert.equal(cfg.runtime.respectGitignore, false);
});
```

Extend the baseline test to assert:

```js
const modern = await captureBaseline(dir, {
  extraSkipDirs: ["scratch"],
  respectGitignore: true,
});
assert.equal(modern.respectGitignore, true);
assert.deepEqual(modern.extraSkipDirs, ["scratch"]);

const legacy = await captureBaseline(dir, ["scratch"]);
assert.equal(legacy.respectGitignore, false);
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```text
node --test test/core/config.test.js test/core/load-config.test.js test/core/edit-scope-and-skip.test.js
```

Expected: failures because `respectGitignore` and object-form baseline options are not implemented.

- [ ] **Step 3: Implement normalized runtime scope**

Add to `DEFAULT_CONFIG.runtime`:

```js
respectGitignore: true,
```

In `diff.js`, add normalization with these semantics:

```js
function normalizeBaselineScope(scope) {
  if (Array.isArray(scope)) {
    return { extraSkipDirs: scope, respectGitignore: false };
  }
  const input = scope && typeof scope === "object" ? scope : {};
  return {
    extraSkipDirs: Array.isArray(input.extraSkipDirs) ? input.extraSkipDirs : [],
    respectGitignore:
      input.respectGitignore === undefined ? true : input.respectGitignore === true,
  };
}

function baselineRespectsGitignore(baseline) {
  return baseline?.respectGitignore === true;
}
```

Store both values on Git and filesystem baselines. Update CLI captures to pass:

```js
await captureBaseline(cwd, {
  extraSkipDirs: config.runtime?.extraSkipDirs,
  respectGitignore: config.runtime?.respectGitignore,
});
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 1 test command. Expected: all pass.

- [ ] **Step 5: Commit**

```text
git add src/core/config.js src/core/diff.js src/cli/hook.js src/cli/run.js src/cli/check.js test/core/config.test.js test/core/load-config.test.js test/core/edit-scope-and-skip.test.js
git commit -m "feat: persist trusted gitignore review scope"
```

### Task 2: Git Untracked Enumeration and Compatibility

**Files:**
- Modify: `test/core/diff.test.js`
- Modify: `src/core/diff.js`

- [ ] **Step 1: Replace the old ignored-file expectation with failing user-first tests**

Cover four independent behaviors:

```js
assert.equal(paths.includes("ignored/runtime.js"), false);
assert.equal(paths.includes("visible.js"), true);
assert.equal(diff.text.includes("ignored/runtime.js"), false);
assert.equal(diff.text.includes("visible.js"), true);
```

Track a file and then add an ignore rule:

```js
gitSync(repo, ["add", "tracked.log", ".gitignore"]);
gitSync(repo, ["commit", "-q", "-m", "base"]);
await writeFile(join(repo, "tracked.log"), "changed\n");
assert.equal(paths.includes("tracked.log"), true);
```

Restore exhaustive behavior:

```js
const baseline = await captureBaseline(repo, { respectGitignore: false });
assert.equal(paths.includes("ignored/runtime.js"), true);
```

Verify an old persisted baseline without the field remains exhaustive by deleting
`baseline.respectGitignore` before building the diff.

- [ ] **Step 2: Run the Git diff tests and verify RED**

Run:

```text
node --test test/core/diff.test.js
```

Expected: the new default-exclusion assertions fail against current enumeration.

- [ ] **Step 3: Enumerate once and reuse the result**

Change untracked enumeration to:

```js
async function gitUntrackedFiles(cwd, skipSet, respectGitignore) {
  const args = ["ls-files", "-z", "--others"];
  if (respectGitignore) args.push("--exclude-standard");
  const result = await git(args, cwd);
  if (result.code !== 0 || result.truncated) {
    throw new Error("git_untracked_listing_failed");
  }
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map(toPosixSlashes)
    .filter((rel) => !isUnderSkipDir(rel, skipSet));
}
```

In `buildReviewDiff()`, fetch the list once, use it to synthesize blocks, and pass
the same array to:

```js
changedFiles(cwd, baseline, { untrackedFiles })
```

When `changedFiles()` is called without the option, it performs one policy-aware
enumeration itself.

- [ ] **Step 4: Run the Git diff tests and verify GREEN**

Run the Task 2 command. Expected: all pass, including Unicode/newline path tests.

- [ ] **Step 5: Commit**

```text
git add src/core/diff.js test/core/diff.test.js
git commit -m "fix: exclude ignored untracked files by default"
```

### Task 3: Zero-Commit Git-Aware Filesystem Snapshots

**Files:**
- Modify: `test/core/diff.test.js`
- Modify: `src/core/diff.js`

- [ ] **Step 1: Write failing zero-commit and non-Git tests**

Create a zero-commit repository containing `.gitignore`, an ignored file, and a
visible file before baseline capture. Assert:

```js
assert.equal(baseline.type, "filesystem");
assert.equal(baseline.snapshotSource, "git-files");
assert.equal("ignored/cache.bin" in baseline.snapshot, false);
assert.equal("visible.js" in baseline.snapshot, true);
```

After baseline capture, add another ignored and visible file and assert only the
visible file appears in `changedFiles`.

For a genuine non-Git workspace with a `.gitignore` file, assert an otherwise
ignored path remains part of the filesystem snapshot and diff.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```text
node --test test/core/diff.test.js
```

Expected: `snapshotSource` is absent and ignored files are captured in the
zero-commit repository.

- [ ] **Step 3: Implement `snapshotGitFiles()`**

Use:

```text
git ls-files -z --cached --others --exclude-standard
```

Reject nonzero or truncated output. Sort and deduplicate paths. Apply existing
skip-directory rules. For each present path, use `lstat()`:

- symbolic link: `snapshotSymlink()`;
- regular file: `snapshotFile()`;
- missing/non-regular: omit.

Respect the existing `maxFiles` cap and return `{ files, truncated }`.

Set `snapshotSource: "git-files"` only for zero-commit Git repositories with
`respectGitignore=true`; otherwise use `"filesystem-walk"`. In
`buildFilesystemReviewDiff()`, select the current snapshot function from the
recorded source. Missing `snapshotSource` means `"filesystem-walk"`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 3 command. Expected: all pass.

- [ ] **Step 5: Commit**

```text
git add src/core/diff.js test/core/diff.test.js
git commit -m "fix: honor gitignore in zero-commit repositories"
```

### Task 4: Ignored-File Count and One-Shot Diagnostic

**Files:**
- Modify: `test/core/diff.test.js`
- Modify: `test/core/gate.test.js`
- Modify: `src/core/git.js`
- Modify: `src/core/diff.js`
- Modify: `src/core/gate.js`

- [ ] **Step 1: Write failing metadata and callback tests**

Assert a Git diff with two ignored untracked files returns:

```js
assert.equal(diff.ignoredUntrackedSkipped, 2);
```

Assert exhaustive mode and a clean repository return zero.

Pass a callback to `evaluateGate()`:

```js
const messages = [];
await evaluateGate({
  config,
  cwd,
  baseline,
  transcript: editTranscript("visible.js"),
  stateDir: await tmpStateDir(),
  onScopeDiagnostic: (message) => messages.push(message),
});
assert.deepEqual(messages, [
  "adversarial-review: skipped 2 gitignored untracked file(s) (respectGitignore=true)",
]);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```text
node --test test/core/diff.test.js test/core/gate.test.js
```

Expected: metadata and callback assertions fail.

- [ ] **Step 3: Add a streaming NUL counter**

Export from `git.js`:

```js
export async function gitCountNulRecords(args, cwd) {
  // Spawn git with GIT_GLOBAL_ARGS, count byte value 0 in stdout chunks,
  // bound stderr with MAX_STDERR_BYTES, and resolve
  // { code, count, stderr } without retaining stdout.
}
```

In `buildReviewDiff()`, when policy is enabled, count:

```text
git ls-files -z --others --ignored --exclude-standard
```

Counting failure returns zero and does not fail authoritative diff construction.
Return `ignoredUntrackedSkipped` without incorporating it into `text` or
`diffHash`.

After `evaluateGate()` builds the authoritative diff, call `onScopeDiagnostic`
once when count is positive. Do not pass the callback to quiescence sampling or
fail-closed probes.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 4 command. Expected: all pass.

- [ ] **Step 5: Commit**

```text
git add src/core/git.js src/core/diff.js src/core/gate.js test/core/diff.test.js test/core/gate.test.js
git commit -m "feat: report skipped gitignored files"
```

### Task 5: CLI and Hook Diagnostic Wiring

**Files:**
- Modify: `src/cli/hook.js`
- Modify: `src/cli/run.js`
- Modify: `src/cli/check.js`
- Modify: `test/cli/hook.test.js`
- Modify: `test/cli/run.test.js`
- Modify: `test/cli/check.test.js`

- [ ] **Step 1: Write failing entry-point tests**

For each entry point, use an ignored file and capture stderr. Assert:

```js
assert.match(
  stderr,
  /adversarial-review: skipped 1 gitignored untracked file\(s\) \(respectGitignore=true\)/
);
assert.equal(
  stderr.match(/adversarial-review: skipped/g)?.length,
  1
);
```

Add one zero-count case asserting no diagnostic.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```text
node --test test/cli/hook.test.js test/cli/run.test.js test/cli/check.test.js
```

Expected: no diagnostic is currently written.

- [ ] **Step 3: Wire the callback**

Pass to each authoritative `evaluateGate()` call:

```js
onScopeDiagnostic: (message) => io.stderr.write(`${message}\n`),
```

Do not add it to `stillChangingScope()` or any direct `buildReviewDiff()` sample.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 5 command. Expected: all pass.

- [ ] **Step 5: Commit**

```text
git add src/cli/hook.js src/cli/run.js src/cli/check.js test/cli/hook.test.js test/cli/run.test.js test/cli/check.test.js
git commit -m "feat: surface gitignore scope diagnostics"
```

### Task 6: Documentation and Migration Notes

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update README configuration**

Add trusted user/global configuration:

```json
{
  "runtime": {
    "respectGitignore": true,
    "extraSkipDirs": []
  }
}
```

Document that:

- default `true` excludes only untracked ignored files;
- tracked ignored files remain reviewed;
- project config cannot change the runtime value;
- users auditing untrusted repositories can set the trusted value to `false`.

- [ ] **Step 2: Add an Unreleased changelog entry**

Add:

```markdown
## [Unreleased]

### Fixed
- The gate now honors `.gitignore` for untracked files by default, preventing
  ignored caches/build output from permanently truncating and blocking reviews.
  Trusted user/global config may set `runtime.respectGitignore:false` for
  exhaustive untrusted-repository audits. Tracked ignored files remain covered.
```

- [ ] **Step 3: Check documentation formatting**

Run:

```text
git diff --check
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```text
git add README.md CHANGELOG.md
git commit -m "docs: explain gitignore-aware review scope"
```

### Task 7: Full Verification and Adversarial Review

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run targeted regression suites**

```text
node --test test/core/config.test.js test/core/load-config.test.js test/core/edit-scope-and-skip.test.js test/core/diff.test.js test/core/gate.test.js test/cli/hook.test.js test/cli/run.test.js test/cli/check.test.js
```

Expected: zero failures.

- [ ] **Step 2: Run full tests**

```text
npm test
```

Expected: zero failures; platform-specific skips are acceptable.

- [ ] **Step 3: Verify package contents**

```text
npm run pack:dry-run
```

Expected: exit 0 and package includes `src/`, `bin/`, README, changelog, license,
and plugin manifest.

- [ ] **Step 4: Run static repository checks**

```text
git diff --check
git status --short
```

Expected: no whitespace errors and only intended changes before final commit.

- [ ] **Step 5: Request independent code review**

Review the complete implementation range against:

```text
docs/superpowers/specs/2026-06-19-respect-gitignore-design.md
```

Fix every Critical or Important finding and rerun Steps 1-4.

- [ ] **Step 6: Final verification commit**

If review fixes were required:

```text
git add -A
git commit -m "fix: address gitignore scope review findings"
```

Then rerun `npm test` and `npm run pack:dry-run` before reporting completion.
