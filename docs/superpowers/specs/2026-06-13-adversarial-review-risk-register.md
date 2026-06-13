# Adversarial Review Risk Register

This register tracks design risks for the Node multi-tool adversarial review
package. Status values:

- Mitigated: design contains an explicit prevention or detection mechanism and
  a test requirement.
- Accepted: cannot be fully solved by this package; must be disclosed.
- Open: needs more design work before implementation.

## Risks

| Risk | Status | Decision | Required Evidence |
|---|---|---|---|
| Agent commits changes before gate runs, making working tree clean | Mitigated | Review from session/wrapper baseline, not from current working-tree dirtiness | Test committed-during-session diff is reviewed |
| Native hook has no session baseline and sees only a clean tree at Stop | Mitigated | Native integrations that support lifecycle hooks record a baseline at session start; enforced/strict block when edit evidence exists but baseline is missing | Tests for SessionStart baseline and Stop-only missing-baseline block |
| Small code change bypasses review | Mitigated | Default `enforced` uses `reviewScope: "all-code"` | Test small code diff blocks/reviews in enforced |
| External reviewer outage weakens review | Mitigated | `onReviewerError` defaults to `block` in `enforced` and `strict-ci` | Test timeout/non-zero/malformed output blocks by default |
| Valid external fail is accidentally treated as retry/fallback | Mitigated | Valid `fail` blocks immediately; only operational failures use `onReviewerError` | Test valid fail does not run self-review |
| Project config weakens user policy | Mitigated | User-level policy floor cannot be loosened by project config | Test project downgrade is rejected |
| Agent edits config/prompt during same session to weaken gate | Mitigated | Effective config is locked at session start; changed config/prompt files are sensitive | Test changed config is evaluated under previous policy |
| Custom reviewer command injection | Mitigated | Custom reviewer uses structured `command` + `args`, `shell: false`, allowlisted placeholders, explicit trust | Tests for shell=false and unknown placeholder rejection |
| Pass cache replay after prompt/config/model/reviewer changes | Mitigated | Cache key includes diff/config/prompt/reviewer/version/model/level/privacy | Tests for cache invalidation on each key dimension |
| Diff prompt-injects reviewer into passing | Mitigated | Diff is untrusted data, delimited separately, final verdict must match job metadata | Tests with malicious diff text and embedded fake verdict |
| Fake or unfinished self-review token is counted as pass | Mitigated | Native self-review pass requires a completed Task/Agent result or verified host completion marker after the last edit | Tests for prompt-only token and unfinished task not satisfying the gate |
| Stale verdict after files change during review | Mitigated | Post-review freshness check recomputes review scope before allow | Test changes after review start invalidate verdict |
| Shell/generator modifies files without transcript edit event | Mitigated | Filesystem/git baseline diff is authoritative, transcript is supplementary | Test shell-created file is reviewed |
| Non-git workspace changes are invisible to review diff | Mitigated | Filesystem baseline snapshots reviewable files and synthesizes text diffs or binary metadata for added/modified/deleted files | Non-git wrapper/check tests for added, modified, deleted, and binary files |
| Symlink/path traversal escapes workspace | Mitigated | Canonicalize paths, block paths outside root, never follow symlinks for temp writes | Tests for symlink escape and outside-root resolution |
| Submodule pointer hides code change | Mitigated | Submodule pointer changes are reviewable and sensitive by default | Test submodule pointer change classification |
| Large diff is truncated but passes | Mitigated | Truncation is coverage limitation; pass invalid in enforced/strict when relevant content omitted | Test truncated diff pass is rejected |
| Binary/runtime artifact change is ignored | Mitigated | Binary metadata is reviewable; runtime-affecting binaries are sensitive | Test binary executable/runtime file classified reviewable |
| Generated committed code is ignored | Mitigated | Generated output affecting runtime is reviewable; large generated output needs source + reproducibility check | Test generated runtime file requires review |
| Reviewer claims pass with empty or incomplete coverage | Mitigated | Enforced/strict validates covered files, dimensions, limitations, and payload hash before accepting pass | Tests for empty coverage, missing changed-file coverage, and undocumented limitations |
| External review sends secrets or private code | Mitigated | Privacy policy and local secret scan block or prompt before external review | Secret scan tests and docs disclosure |
| External review sends proprietary code without clear consent | Mitigated | Default privacy requires prompt/explicit user-level consent before external reviewers; non-interactive hooks block when consent is absent | Tests for installer consent requirement and hook behavior without consent |
| Secret scanner misses a secret | Accepted | Scanner is best effort, not DLP; disclose residual risk | README residual-risk section |
| Reviewer can edit files | Mitigated | Reviewer isolation requires read-only/no-edit mode in enforced/strict | Adapter capability tests |
| Reviewer path/version changes after install | Mitigated | Runtime re-verifies changed path/version/capabilities | Test changed reviewer executable forces reverify/block |
| Installer corrupts host config or cannot roll back | Mitigated | Installer uses dry-run, backups, idempotent marker-owned edits, atomic writes, and uninstall/repair commands | Snapshot tests for backup, restore, and idempotent reinstall |
| Wrapper cannot force interactive agent to continue | Accepted | Wrapper is `wrapper-enforced`, not native; disclose limitation | Installer and README show enforcement level |
| Detached background process edits after wrapper exits | Accepted with mitigation | Wrapper uses quiescence/double snapshot; detached long-running mutation remains residual | Test quiescence catches immediate post-exit changes; docs disclose residual |
| Host ignores documented hook contract | Accepted | Out of scope; host contract must be trusted | README residual-risk section |
| Malicious local user disables plugin or edits user policy | Accepted | Same-user tampering is out of scope | README residual-risk section |
| Malicious reviewer provider lies | Accepted | Provider trust is out of scope; multi-reviewer can reduce but not eliminate | README residual-risk section |

## Current Assessment

No design risks are intentionally left open. The remaining accepted risks are
host/provider/local-user trust boundaries that this package cannot fully control.
They must be disclosed prominently before public release.
