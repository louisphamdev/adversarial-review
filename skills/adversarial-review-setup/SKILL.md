---
name: adversarial-review-setup
description: Use when the user wants to set up, install, activate, configure, or tune the adversarial-review code-quality gate (NodeJS version) — e.g. "setup adversarial-review", "install the adversarial review gate", "make codex/claude-code review with opencode", "make the review gate stricter/looser". Installs host hooks/wrappers, maps reviewers, tunes policy mode, and explains how the gate behaves.
---

# Setting up the adversarial-review gate (NodeJS)

This package is a multi-tool **adversarial review gate**: when a coding agent makes
a significant code change, the gate forces it through a fresh-context reviewer
that tries to **break** the diff (correctness, edge cases, security, broken
invariants) before the agent may finish. It supports multiple host tools and lets
one tool outsource review to another (e.g. Claude Code reviewed by opencode) or
self-review.

Work through these steps with the user. Keep it concrete.

## 1. Verify the environment
- `node --version` → must be **>= 20**. No Python is required.
- The package entrypoint is `bin/adversarial-review.js`. From the package dir you
  can run `node ./bin/adversarial-review.js doctor` to print the current state.
- If a reviewer tool will be used, confirm it is installed and authenticated:
  - opencode: `opencode --version`
  - codex: `codex --version`

## 2. Choose hosts and reviewers
Ask the user which **host(s)** they code in and which **reviewer** each should use:
- Hosts: `claude-code` (native Stop hook), `codex`, `opencode`, `github-copilot-cli`,
  `antigravity` (the last four are wrapper-enforced).
- Reviewer per host: another tool (`opencode`, `codex`, a trusted `custom` command),
  or `none` (self-review orchestration — the host runs the bundled adversarial
  reviewer subagent itself). A host may not review itself unless via `none`.

Install (interactive, or with flags):
```
npx adversarial-review install \
  --hosts claude-code,codex \
  --reviewer claude-code=opencode \
  --reviewer codex=opencode
```
Add `--dry-run` first to preview every file it would write. The installer refuses
to map a host to itself and refuses an unavailable reviewer (unless `none`).

## 3. Pick a policy mode
- `soft` — developer-friendly, fail-open. Reviewer errors don't block; small
  changes pass with an advisory. Good for a first trial.
- `enforced` (default) — fail-closed. Significant code changes block until review
  passes; reviewer/operational failures block.
- `strict-ci` — fail-closed + advisory hosts rejected, skip requests ignored.

Set per project in `.adversarial-review/config.json`, or machine-wide in
`~/.adversarial-review/config.json` (merged DEFAULT < user < project, then the
user policy floor in `~/.adversarial-review/policy.json` which can only tighten).

## 4. If the reviewer is **opencode**, set up a read-only agent (REQUIRED)
opencode review only works with a dedicated read-only agent. Common gotchas:
- Create the agent at `~/.config/opencode/agent/adversarial-reviewer.md`.
- It MUST be `mode: primary` — `opencode run --agent` rejects a *subagent* and
  silently falls back to the full-permission default agent (the gate detects that
  fallback and rejects the review).
- Make it read-only: `permission: { edit: deny, bash: deny, webfetch: deny,
  websearch: deny }` and turn tools off (`write/edit/patch/bash: false`). With
  `reviewers.opencode.readOnlyConfig: true` in config, the gate's enforced
  isolation check (readOnly && noEdit) then passes.
- The agent body must include the verdict-block format the gate parses (the brief
  delivered on stdin carries the per-job `job_id`/`diff_hash` to echo).
- Verify: `opencode agent list` shows `adversarial-reviewer`, and a test review
  prints a `<<<ADVERSARIAL-REVIEW-VERDICT>>> … <<<END>>>` block.

## 5. Wire the hosts
- **Claude Code (native):** add a `SessionStart` hook (records the baseline) AND a
  `Stop` hook (applies the gate) to settings.json. For a local (non-marketplace)
  install the command needs an ABSOLUTE path to `bin/adversarial-review.js`
  (`${CLAUDE_PLUGIN_ROOT}` only resolves inside a marketplace plugin). A Stop hook
  with edit evidence but no recorded SessionStart baseline fails closed in
  enforced — so the SessionStart hook is required.
- **Wrapper hosts (codex/opencode/…):** the user must launch the tool THROUGH the
  wrapper, e.g. `adversarial-review run --host codex -- codex exec "…"`. A
  convenience launcher (`codex-reviewed`) on PATH helps. Plain `codex` bypasses
  the gate — disclose this.

## 6. Confirm and explain
- Run `node ./bin/adversarial-review.js doctor` — it should show the effective
  mode, each host, the reviewer path/version, and `reviewer capabilities:
  {readOnly:true,noEdit:true}` when read-only is configured.
- Explain the cost: an external opencode review takes ~30s and BLOCKS in enforced
  until it passes. Machine-wide enforced therefore gates every significant-edit
  Stop across all projects. Recommend `soft` for a first trial; when developing
  the gate's own repo, put `{"policy":{"mode":"soft"}}` in that repo's
  `.adversarial-review/config.json` so you don't gate your own work.
- Off-switch: delete/edit `~/.adversarial-review/config.json` (or set mode `soft`)
  and remove the `hooks` block from `~/.claude/settings.json`.

## Notes
- It is a quality & workflow guard, **not a security sandbox**. See the README's
  Residual Risks.
- The gate reviews the baseline→current diff (git or filesystem snapshot),
  including changes committed during the session, and scans for secrets before
  sending code to an external reviewer.
