# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
