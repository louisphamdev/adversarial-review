---
name: adversarial-review-setup
description: Use when the user wants to set up, install, activate, configure, or tune the adversarial-review code-quality gate (NodeJS version) — e.g. "setup adversarial-review", "install the adversarial review gate", "make codex/claude-code review with opencode", "make the review gate stricter/looser". Installs host hooks/wrappers, maps reviewers, tunes policy mode, and explains how the gate behaves.
---

# Setting up the adversarial-review gate (NodeJS)

This package is a multi-tool **adversarial review gate**. When a coding agent makes
a significant code change, the native gate is **advisory**: it suggests which
changed files to review (with reasons) and lets the agent decide whether to run a
fresh-context reviewer that tries to **break** the diff (correctness, edge cases,
security, broken invariants) — or skip a change it judges trivial. Detected
secrets are the one **hard block** that always stands, in every mode. It supports
multiple host tools and lets one tool outsource review to another (e.g. Claude
Code reviewed by opencode) or self-review.

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

Install (`--hosts` and `--reviewer` are required — there is no interactive
wizard yet):
```
npx adversarial-review-gate install \
  --hosts claude-code,codex \
  --reviewer claude-code=opencode \
  --reviewer codex=opencode
```
Add `--dry-run` first to preview every file it would write. The installer refuses
to map a host to itself and refuses an unavailable reviewer (unless `none`). Use
`--global` (alias `--user`) to install machine-wide (writes
`~/.adversarial-review/config.json` and merges hooks into `~/.claude/settings.json`).

## 3. Pick a policy mode
Since v2.3.0 the **native self-review gate is advisory in all modes** — it
suggests review (listing files + reasons) and lets the agent self-review or skip;
operational limitations are surfaced, not blocked; only detected secrets hard-block.
The mode now primarily governs the **external-reviewer** path (when a host is
mapped to opencode/codex/a custom reviewer) and the user policy floor:
- `soft` — developer-friendly. External reviewer errors don't block.
- `enforced` (default) — external reviewer errors/operational failures block, and
  a configured external reviewer's FAIL verdict blocks.
- `strict-ci` — enforced + advisory hosts rejected, user skip requests ignored.

Set per project in `.adversarial-review/config.json`, or machine-wide in
`~/.adversarial-review/config.json` (merged DEFAULT < user < project, then the
user policy floor in `~/.adversarial-review/policy.json` which can only tighten).

## 4. If the reviewer is **opencode**, VERIFY the read-only agent
The installer does this for you: when a host maps to `--reviewer <host>=opencode`,
it creates the read-only agent at `~/.config/opencode/agent/adversarial-reviewer.md`
(idempotent — skipped if the file already exists) AND writes
`reviewers.opencode.readOnlyConfig: true` into the project config. You only need
to **verify** it:
- `opencode agent list` shows `adversarial-reviewer`.
- `node ./bin/adversarial-review.js doctor` reports the opencode reviewer with
  capabilities `{readOnly:true,noEdit:true}` (no `reviewer_agent_missing`).

The bundled agent guarantees the three invariants the gate enforces (explain
these only if the user wants to customize the agent — the installer never
overwrites an existing file):
- `mode: primary` — `opencode run --agent` rejects a *subagent* and silently
  falls back to the full-permission default agent (the gate detects that fallback
  and rejects the review).
- Read-only: `permission: { edit: deny, bash: deny, webfetch: deny, websearch:
  deny }` and tools off. With `reviewers.opencode.readOnlyConfig: true` the gate's
  enforced isolation check (readOnly && noEdit) passes.
- The agent body includes the verdict-block format the gate parses (the brief on
  stdin carries the per-job `job_id`/`diff_hash` to echo).

## 5. VERIFY the host wiring (the installer wrote it)
- **Claude Code (native):** the installer already merged a `SessionStart` hook
  (records the baseline) AND a `Stop` hook (applies the gate, 300s timeout) into
  `.claude/settings.json` — or `~/.claude/settings.json` with `--global`. Verify
  with `node ./bin/adversarial-review.js doctor`, then **restart Claude Code** so
  it re-reads settings.json. (A Stop hook with edit evidence but no recorded
  SessionStart baseline fails closed in enforced — both hooks are required, and
  the installer writes both. For a local non-marketplace checkout not on PATH,
  the hook command needs an ABSOLUTE path to `bin/adversarial-review.js`;
  `${CLAUDE_PLUGIN_ROOT}` only resolves inside a marketplace plugin.)
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
