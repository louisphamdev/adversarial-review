# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
