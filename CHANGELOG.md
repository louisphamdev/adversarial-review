# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.7] - 2026-06-15

Makes CI actually green for the first time (a latent test bug only surfaced once the
`npm ci` install step was fixed in 2.2.3), and fixes a second non-git "block every turn"
trigger.

### Fixed
- **CI test step failed on Node 20/22 — a hook test left a pending promise.** The stdin /
  transcript read timeouts in the Stop hook were `unref()`'d, relying on the stdin pipe
  to keep the event loop alive until the timeout fires. A test's mock stdin (and a
  non-pipe real stdin) does NOT keep the loop alive, so on Node 20/22 the unref'd timer
  was skipped when the loop drained and the read promise hung forever — which Node's test
  runner reports as a failure and which would be a fail-OPEN under the real host. The
  timeouts are no longer unref'd (they are still cleared on the fast path, so a normal
  read is never delayed). Verified green on Node 20, 22, and 26, Linux + Windows.
- **`.spec-workflow` scaffolding caused the gate to block every Stop on a non-git
  workspace.** The MCP `spec-workflow` server writes template/spec files into the
  workspace at SessionStart — after the gate's baseline snapshot — so on a non-git
  workspace they read as permanently "added" in every diff and the gate blocked every
  turn (even no-op turns). `.spec-workflow` is now in the built-in skip list (alongside
  `node_modules`, `.venv`, etc.), so this tool-generated scaffolding is excluded from
  review on both the filesystem and git-untracked paths.
- **FIFO/device transcript path hung the Stop hook on POSIX.** Reading a `transcript_path`
  that is a FIFO/device opened a stream whose `open()` BLOCKS forever in libuv's thread
  pool (a FIFO open waits for a writer) and could not be cancelled by the abort timeout —
  the read promise resolved on the timeout but the leaked thread kept the hook process
  alive so it never exited (the host then killed it: a fail-OPEN). The transcript reader
  now `stat()`s the path first (stat never blocks) and treats any non-regular file as
  empty, skipping the dangerous open entirely.

### CI / tests
- **The test suite had never run in CI** (every run failed at `npm ci` before 2.2.3), so
  it had accumulated latent platform/environment failures that only surfaced once the
  install + hook-hang issues were fixed. Cleaned up so the suite is green on the full CI
  matrix (Linux + Windows, Node 20/22): a `resolveHomeDir` test used a Windows-only
  absolute path (not absolute on POSIX); a custom-reviewer stub read the wrong `argv`
  indices; an install test required the `codex` CLI to be present (now uses a
  no-binary reviewer); and a wall-clock, background-process-timing test is skipped under
  CI (its soft-mode behavior is also covered deterministically elsewhere). Verified
  green on Node 20/22 (Linux, via Docker) and Node 20/22/26 (Windows).

## [2.2.6] - 2026-06-15

Fixes a hard `RangeError` that made the gate unusable on workspaces containing a large
virtualenv whose name was not exactly `.venv`.

### Fixed
- **`buildReviewDiff` threw `RangeError: Invalid string length` → gate failed closed
  every turn.** `SKIP_DIRS` only matched the literal `.venv`, so a virtualenv with a
  variant name (`.venv-mcp`, `venv311`, `virtualenv`, …) was not skipped: every file in
  it (a torch install is >1 GB) was synthesized into the diff, and the final
  `chunks.join("\n")` exceeded V8's ~512 MiB max string length. The throw made
  `evaluateGate` see `diff === null` and block every turn with a misleading "repository
  may be corrupted". The skip list now matches common virtualenv name **variants** (in
  both the filesystem walk and the git-untracked filter), kept precise so a real source
  directory is never skipped (`venvironment`, `env`, `myvenv` are NOT matched).

### Robustness
- **Total-diff byte budget (defense-in-depth).** Any pathological large untracked/added
  tree (not just a virtualenv) now degrades to the coverage-limitation sentinel — the
  gate fails closed with a clear "diff too large, review manually" message — instead of
  crashing on an over-long string. The synthesized diff can no longer overflow V8's
  string limit.
- **`isUnderSkipDir` now matches only PARENT path segments**, so a real source file
  literally named like a skip directory (e.g. `venv.py`, `node_modules`) is still
  reviewed rather than silently skipped (a basename match was a latent fail-open).

### Hardened in review (GPT-5.5-xhigh, dogfooded via opencode)
An adversarial review of this fix surfaced four more issues, all fixed + tested before
release:
- **Virtualenv match made precise** — the first regex was too broad and would have
  SKIPPED real source directories like `venv-api`, `venv_src`, `virtualenv.config` (a
  fail-open). It now matches dotted `.venv*` broadly but a non-dotted name only when
  unambiguous (`venv`, `venv311`, `virtualenv`).
- **Newline-in-filename fail-open closed** — git output is now parsed NUL-delimited
  (`ls-files -z`, `diff --name-status -z`); previously a file named `src/evil\n.js` was
  split into fake paths and its real content hidden from the reviewer.
- **Huge single file no longer OOMs the gate** — synthesized diffs now read at most the
  per-file cap (+1) instead of loading the whole file, so one 900 MB untracked text file
  can't crash the gate before the cap applies.
- **Byte budget covers the base git diff too** — if the committed/working/staged diffs
  alone exceed the cap (with no untracked files), the coverage sentinel still fires.

## [2.2.5] - 2026-06-15

`doctor` now recognizes a gate armed via the Claude Code **plugin** — closing a
false-negative health verdict.

### Fixed
- **`doctor` falsely reported "not enforced" for a plugin-armed gate.** Its hook-
  registration check only read `.claude/settings.json`, but Claude Code loads a
  plugin's hooks from the installed plugin manifest at runtime and never writes them
  into settings.json. So a gate armed purely by the plugin made `doctor` warn "hooks
  NOT registered" and exit non-zero (a CI step would fail on a gate that IS enforcing).
  `doctor` now also reads Claude Code's on-disk plugin state — `installed_plugins.json`
  (install records + paths), `enabledPlugins` across settings scopes, and the installed
  manifest's hooks — and counts the gate as enforced when the plugin is **installed AND
  enabled AND its manifest provides valid canonical SessionStart + Stop hooks**.

### Security / accuracy
- The plugin path counts as enforced ONLY when all three conditions hold, so an
  installed-but-**disabled** plugin, or one whose installed manifest hooks are
  stale/broken (e.g. the pre-2.2.4 flat-string schema), is still reported as NOT
  enforcing — no false "enforced" confidence. `doctor`'s warning now names the precise
  cause (disabled vs. stale manifest vs. not installed) and the exact remediation.
- An adversarial review (GPT-5.5-xhigh, dogfooded via opencode) of this change closed
  two FALSE-POSITIVE vectors before release: (1) the canonical hook matcher now
  requires `type:"command"`, so a leaf carrying our command string under a non-command
  type (which Claude Code never executes) is no longer counted as registered; (2) the
  plugin detector now verifies the installed manifest's `name` matches our plugin, so a
  stale/impersonating install record keyed as ours cannot fake an enforced gate.

## [2.2.4] - 2026-06-15

A fix to the **Claude Code plugin manifest** itself — the channel that had silently
kept the gate from arming on a fresh marketplace install.

### Fixed
- **Plugin manifest `hooks` had an INVALID schema → plugin failed to load → gate
  silently OFF.** `.claude-plugin/plugin.json` declared its hooks as a FLAT STRING
  (`"SessionStart": "node …"`) instead of the nested
  `[{ "hooks": [{ "type": "command", "command": "…" }] }]` array Claude Code
  requires. A `marketplace add`/`update` re-clone would fail validation and load no
  hooks, so the Stop gate never fired — the worst failure mode for a security gate
  (silently disabled). The manifest now uses the correct nested schema (matching the
  installer's own output), with the Stop hook's 300s timeout preserved so a real
  review is not killed mid-flight.
- **Plugin manifest version drift:** `plugin.json` was pinned at `2.1.0` while the
  package had moved several patches ahead. It now tracks the package version, and a
  new meta-test (`test/meta/plugin-manifest.test.js`, run in CI and `prepublishOnly`)
  fails the pipeline on any future version drift OR a regression back to the invalid
  flat-string hooks schema — so a broken manifest can never ship again.

## [2.2.3] - 2026-06-14

A sixth review round driven by **GPT-5.5 (xhigh reasoning)**, one monitor subagent
per outsourced reviewer shell. It surfaced gaps the previous five rounds missed —
two Windows command-search RCE vectors, an unguarded `HOME`/`USERPROFILE`, and a
handful of filesystem-baseline / quoting fail-opens — plus the reason **CI had been
red on every recent commit**. All confirmed findings reproduced, fixed fail-closed,
and regression-tested. 713 tests, 705 pass, 8 platform-skips.

### CI
- **Every recent CI run was failing before the test step:** the workflow runs
  `npm ci`, which REQUIRES a `package-lock.json`, but none was committed (`npm ci`
  errors out without a lockfile). A minimal lockfile (the package has zero runtime
  deps) is now checked in, so `npm ci` — and therefore the whole pipeline — runs.

### Security
- **Windows reviewer RCE via bare `cmd.exe` / `taskkill` (two vectors):** spawning a
  batch (`.cmd`/`.bat`) reviewer wrapper used a bare `cmd.exe`, and the watchdog's
  force-kill used a bare `taskkill` — both resolved by `CreateProcess` from the
  UNTRUSTED repo's working directory first, so a repo-local `cmd.exe`/`taskkill.exe`
  could execute and break the read-only reviewer isolation. Both now anchor to an
  absolute `%SystemRoot%\System32\…` path.
- **`HOME`/`USERPROFILE` could relocate the trusted user base into the repo:** the
  round-6 fix guarded only the dedicated `ADVERSARIAL_REVIEW_HOME` override against
  pointing inside `cwd`. A repo-controlled wrapper setting `HOME=$PWD` /
  `USERPROFILE=%CD%` could still move the trusted config/policy/pass-cache into the
  project-writable tree. The same inside-`cwd` guard now applies to `HOME`/
  `USERPROFILE`, with an env-independent `os.userInfo()` fallback for the
  (poisoned-`os.homedir()`) edge.
- **Filesystem-baseline fail-opens (non-git workspaces):** an unreadable directory
  was silently skipped (a change inside it vanished), an unreadable same-size file
  read as "no change", and an unrecognized/corrupted baseline shape returned a
  vacuous empty diff. All three now fail closed (coverage-limitation sentinel /
  thrown detection failure → block in enforced).
- **Hook/wrapper command broke open on `'` or glob chars:** a bin path containing a
  single quote (unterminated POSIX quote → the Stop hook fails to emit a block) or a
  glob char (`* ? [ ]`, expands to the wrong/no executable) was emitted unquoted.
  These are now double-quoted (inert inside double quotes); `$`/backtick stay
  hard-rejected.
- **`check` reviewed nothing on a non-git workspace:** it snapshotted the current
  tree as its own baseline, so already-present (possibly malicious) code passed as
  clean. `check` now reviews a non-git workspace against an empty baseline.
- **Project could null out a user-pinned reviewer entry** to drop its
  models/required-dimensions/timeout back to weaker defaults; a corrupted (null/
  scalar/array) reviewer entry is now restored from the trusted baseline.
- **AWS STS temporary keys (`ASIA…`) added to the secret scanner** (only the
  long-lived `AKIA…` prefix was matched before).
- **Session-state temp file uses a random UUID** instead of `pid`+`Date.now()`, so
  two writes in the same process+millisecond can no longer collide.

## [2.2.2] - 2026-06-14

A fifth review round using yet another model family (Google **Gemini 3.5**,
plus GPT-5.5 / DeepSeek / GLM / Kimi), each driven by its own monitor subagent.
It found parser bypasses and gaps in the round-5 fixes themselves. All confirmed
findings reproduced, fixed fail-closed, and regression-tested. 690 tests, 682
pass, 8 platform-skips.

### Security
- **Verdict parser — two forged-PASS bypasses closed:** a present `findings`
  field that is NOT an array (e.g. an object hiding a Critical) is now rejected
  instead of silently coerced to `[]`; the markdown code-fence detector now tracks
  the fence delimiter char + length (CommonMark), so a longer outer fence with a
  shorter inner fence can no longer expose a quoted forged verdict block.
- **Hook/wrapper command-substitution rejected:** a bin path containing `$` or a
  backtick (which expand even inside double quotes on POSIX) is now refused at
  install time in BOTH the Claude Code hook and the wrapper instructions, instead
  of emitting a command that could execute injected shell code or fail open.
- **Corrupted-repo fail-open closed:** a `git diff` that exits non-zero (e.g. a
  corrupted `.git/index`) is now treated as a detection failure — `buildReviewDiff`
  throws and the gate blocks in enforced/strict — rather than returning an empty
  diff that read as a clean, change-free workspace.
- **Reviewer process-group kill (POSIX):** reviewers are spawned in their own
  process group and the whole group is signalled on timeout, so a reviewer that
  forks a descendant can no longer leave orphaned processes after the watchdog
  fires (Windows already tree-killed via `taskkill /T`).
- **Truncation detection fail-closed:** a per-file truncation marker whose diff
  header cannot be parsed (e.g. a filename containing a newline) now blocks in
  enforced instead of being silently skipped.
- **Config trust floor:** an absolute `ADVERSARIAL_REVIEW_HOME` /
  `ADVERSARIAL_REVIEW_STATE_DIR` that resolves INSIDE the workspace is now ignored
  (a repo-controlled env must not relocate the trusted user base or pre-seed the
  pass cache).
- **Install no longer reads the legacy config from the untrusted cwd during a
  `--user`/`--global` install** (it reads from the scope base / home), closing a
  legacy-config laundering vector into the trusted machine-wide config.

## [2.2.1] - 2026-06-14

A fourth independent review round — driven by deliberately DIFFERENT model
families (DeepSeek / GLM / Kimi / GPT), each monitored by its own subagent — found
issues the earlier (Qwen-dominant) rounds missed, including a **fail-open on the
default install**. All confirmed findings were reproduced, fixed fail-closed, and
regression-tested. 673 tests, 667 pass, 6 platform-skips.

### Security
- **Default install no longer fails open (critical):** the Stop-hook/wrapper bin
  command for the common `npx adversarial-review-gate` invocation was quoted as a
  single token (`"npx adversarial-review-gate"`), so the shell could not find it,
  the hook errored, and — emitting no block — the change was ALLOWED. Composite
  invocations are now tokenized and quoted per-token (the launcher stays bare).
- **Install no longer launders untrusted config:** the installer derives the
  written policy-floor mode from trusted inputs only (default `enforced` / an
  existing user floor / a new `--mode` flag), never the untrusted project config,
  and whitelist-sanitizes the written config (stripping `command`/`args`/`type`/
  `trusted`/`skipPatterns`/unknown keys).
- **Fail-open on detection failure closed:** when gate evaluation OR diff/baseline
  detection fails (e.g. a corrupted `.git` that yields an empty diff without
  throwing), the gate now BLOCKS in enforced/strict instead of allowing
  `fail_open_no_evidence`; `check.js` treats a baseline-capture failure as a block;
  `run` blocks an unobservable (persistently-unbuildable) workspace; `--host=` with
  an empty value is rejected (it had silently downgraded to un-reviewed self-review).
- **Verdict parser:** a finding whose `severity` is non-string / unrecognized is now
  treated as BLOCKING (was silently ignored, letting a smuggled Critical pass).
- **Gate:** a whole-`git-diff`-output truncation (>64 MiB) now blocks in enforced
  (the per-file cap marker missed it); the pass cache stores the validated verdict
  and re-validates on every hit (a pre-written bare-`true` cache entry no longer
  forges a pass).
- **Config trust floor:** a truthy non-boolean `trusted` (`1`/`"true"`) is coerced
  to false; a project cannot change a reviewer's adapter `type` or inject
  `command`/`args`; `version` and `runtime` are pinned; a project config whose real
  path escapes the workspace (a committed symlink) is ignored.
- **Filesystem snapshot:** Windows junctions / escaping directories are no longer
  walked (workspace-escape guard); entries are sorted for a deterministic diffHash.
- **Reviewer timers:** `sanePositiveSec` is clamped so a huge configured timeout
  cannot overflow `setTimeout` to 1 ms (a self-DoS); custom-reviewer temp files are
  owner-only; atomic writes use an unguessable name + `O_EXCL`.

### Added
- `install --mode <soft|enforced|strict-ci>`: explicitly set the written policy
  floor (tighten-only; never below `enforced`).
- Documented the **monitor-subagent-per-reviewer-shell** outsourcing strategy in
  the self-review orchestrator prompt (the agent-host equivalent of the Node
  adapter's watchdog + model-fallback chain).

## [2.2.0] - 2026-06-13

Reviewer resilience plus a deep security-hardening pass driven by an independent,
multi-model adversarial audit of the whole codebase.

### Added
- **Reviewer model fallback chain** (`reviewers.<id>.models`): an optional,
  model-agnostic ordered list. On a transient / rate-limit failure the gate
  retries the next model; a real verdict or a security stop ends the chain. It is
  honored from the **user** config only (a project cannot pin a weak model). The
  plugin ships **no** vendor defaults — unset means a single default invocation.
- **Inactivity-watchdog reviewer timeout**: `reviewers.<id>.timeoutSec` is now an
  *inactivity* window — the reviewer is force-killed only after that long with
  **no output** (the timer resets on every chunk), so a slow-but-streaming
  reviewer is never killed mid-review. A new `reviewers.<id>.maxTimeoutSec` is the
  absolute hard-cap backstop so the gate can never hang. stderr is drained for
  every reviewer (no >64 KB pipe deadlock).

### Security
Hardened against an untrusted (cloned-repo) project config and other adversarial
inputs (each finding was reproduced, fixed, and covered by a regression test):

- **Fail-open on malformed project config fixed (critical):** a `{"policy":null}`
  or `{"privacy":"x"}` scalar no longer crashes config loading (which previously
  produced no block, so the gate failed OPEN). Malformed sub-objects are coerced
  back to safe defaults.
- **Project config is now tighten-only for security:** `mode`, the
  `onReviewerError`/`onInternalError`/`onBlockCap` actions, `allowSkip`,
  `allowAdvisoryHosts`, `reviewScope`, and `privacy.*` are clamped to the trusted
  user/default baseline. A project can tighten `enforced → strict-ci` but never
  loosen `enforced → soft` or `block → allow`. A non-canonical `mode`
  (`"Enforced"`, garbage) falls closed to `enforced`.
- **Host → reviewer mapping is pinned** to the trusted baseline; a project can no
  longer redirect or downgrade which reviewer runs.
- **Reviewer `models` / `requiredDimensions` / `timeoutSec` are user-config-only;**
  a project cannot shrink the review dimensions or set a 0-second timeout.
- **Classifier fails closed:** zero-width / format-unicode filenames, unknown
  non-empty extensions, and dot-prefixed runtime files (`.npmrc`, `.bashrc`, …)
  are now treated as REVIEWABLE instead of slipping through unreviewed.
- **Coverage bypass fixed:** a reviewer citation no longer "covers" a distinct
  unexamined file via speculative `a/`/`b/` prefix stripping or `:line`
  over-stripping; junk coverage above the per-file cap is rejected.
- **Verdict parser hardened:** duplicate JSON keys, prototype-named dimensions,
  and whitespace/case/unicode-lookalike severities can no longer downgrade a
  Critical finding past the forced-fail net.
- **Secret scanner** now catches ED25519 / ENCRYPTED / OPENSSH PEM keys and
  `"password": "…"` JSON/YAML forms, and scans **every** changed path (not only
  the reviewable subset).
- **Non-ASCII paths** (`café.js`, `日本.js`) are no longer mangled by git
  `core.quotePath` (every git call uses `-c core.quotePath=false`); synthesized
  diffs preserve CRLF vs LF so the hash binding is byte-faithful.
- **Stop hook no longer hangs** on an open-but-never-closed stdin; the
  subagent-skip is gated on the authoritative `SubagentStop` host event, not on
  spoofable session-id / path hints; Windows workspace state keys are
  case-normalized.
- **Truncated reviewable content blocks** (enforced) / warns (soft): if a
  reviewable file's diff is capped at the size limit, the reviewer never saw the
  full change, so a pass is not accepted.
- **doctor** reports `native-enforced` only when the Stop hook is actually present
  and untampered, and exits non-zero when a configured native host is not actually
  enforced; **uninstall** removes only the exact hooks we installed; **install**
  writes a tighten-only user policy floor so a cloned repo cannot downgrade the
  chosen mode.
- Self-review now binds payload-hash + full coverage in **every** mode; the
  external-reviewer path re-validates the reviewer's verdict object.

### Changed
- `reviewers.<id>.timeoutSec` is now an inactivity window (was a fixed wall-clock
  deadline); use the new `maxTimeoutSec` for the absolute cap.

## [2.1.1] - 2026-06-13

### Fixed
- Custom-reviewer trust boundary, a `runWithTimeout` timer leak, a coverage
  basename ambiguity, and Windows `PATH`-vs-`Path` env-case resolution.

## [2.1.0] - 2026-06-13

Public-release perfection pass: hardening, machine-wide install, and docs.

### Added
- `install --global` (alias `--user`): machine-wide install that writes the
  host/reviewer defaults to `~/.adversarial-review/config.json` and merges the
  Claude Code `SessionStart` + `Stop` hooks into the user-level
  `~/.claude/settings.json`.
- `uninstall` command (`uninstall [--user]`): removes the hooks this tool wrote
  and the install-registry entry, for both project and machine-wide installs.
- `install` now merges into an existing Claude Code `settings.json` (preserving
  other keys) instead of replacing it.
- Additional `doctor` checks for the merged settings, the opencode read-only
  agent, and reviewer isolation.
- CI workflow (`.github/workflows/ci.yml`): tests on
  `ubuntu-latest`/`windows-latest` x Node 20/22, plus `npm run pack:dry-run`.
- `SECURITY.md`, `CONTRIBUTING.md`, and this `CHANGELOG.md`.
- README badges (npm version, CI, license, node) and documentation for the new
  install flags and `uninstall`.

### Changed
- The installed Claude Code `Stop` hook now carries a **300-second timeout** so a
  debate-tier review is not aborted mid-run.
- Hardened reviewer isolation: enforced/strict-ci modes reject any reviewer that
  is not `readOnly && noEdit`.
- More robust coverage parsing in verdict handling.
- Deduplication of changed-file scope so a file is not reviewed twice.
- `package.json`: added `prepublishOnly` (test + pack dry-run) and
  `publishConfig.access = public`; added `CHANGELOG.md` to the files allowlist.

### Fixed
- `skills/adversarial-review-setup/SKILL.md` referenced the wrong package name
  (`adversarial-review` instead of `adversarial-review-gate`).

## [2.0.3] - 2026-06-13

### Fixed
- A fresh install now produces a working `enforced` + opencode gate out of the
  box: the installer creates the read-only opencode `adversarial-reviewer` agent
  (idempotent), writes `reviewers.opencode.readOnlyConfig: true`, and skips the
  install-time agent-existence check so a clean machine can bootstrap.

## [2.0.2] - 2026-06-13

### Added
- A package-name-matching `adversarial-review-gate` bin so `npx
  adversarial-review-gate` resolves correctly.

## [2.0.1] - 2026-06-13

### Fixed
- Installer bin name corrected to `adversarial-review-gate`.

## [2.0.0] - 2026-06-13

### Added
- Initial NodeJS multi-tool adversarial-review gate, replacing the previous
  Python/Claude-plugin implementation.
- Multi-host support (Claude Code native Stop hook; codex, opencode,
  github-copilot-cli, antigravity via wrapper) with configurable reviewer
  mappings and self-review (`none`) orchestration.
- Policy modes `soft` / `enforced` / `strict-ci`, layered config
  (default < user < project) with a tighten-only user policy floor.
- `install`, `check`, `run`, `doctor`, and `hook` commands.

[2.1.0]: https://github.com/louisphamdev/adversarial-review/releases/tag/v2.1.0
[2.0.3]: https://github.com/louisphamdev/adversarial-review/releases/tag/v2.0.3
[2.0.2]: https://github.com/louisphamdev/adversarial-review/releases/tag/v2.0.2
[2.0.1]: https://github.com/louisphamdev/adversarial-review/releases/tag/v2.0.1
[2.0.0]: https://github.com/louisphamdev/adversarial-review/releases/tag/v2.0.0
