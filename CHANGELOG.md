# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
