# Adversarial Review Design Audit

## Scope

This audit covers the design for converting `adversarial-review` into a NodeJS
multi-tool review gate installed by `npx`.

Audited artifacts:

- `docs/superpowers/specs/2026-06-13-node-multitool-adversarial-review-design.md`
- `docs/superpowers/specs/2026-06-13-adversarial-review-risk-register.md`

The audit evaluates whether the design is strong enough to guide implementation
for a public/community tool. It does not claim the future implementation is
secure until tests and runtime behavior prove the design.

## Audit Rounds

### Round 1: Legacy Bypass Review

Findings addressed:

- Clean working tree / committed changes could bypass review.
- Small code changes could bypass review by default.
- External reviewer operational failure could silently downgrade to self-review.
- Block cap could become a retry-until-allow bypass.

Design changes:

- Review scope is baseline-based and includes commits made during the session.
- Public default is `mode: "enforced"` with `reviewScope: "all-code"`.
- `onReviewerError` defaults to `block` in `enforced` and `strict-ci`.
- `onBlockCap` defaults to `block`; auto-allow is valid only in `soft`.

### Round 2: Trust Boundary Review

Findings addressed:

- Project config could weaken user policy.
- Agent could edit config/prompt files during the same session to weaken the
  gate before it runs.
- Custom reviewer command strings could allow shell injection.
- Reviewer path/version/capabilities could drift after install.

Design changes:

- User-level policy floor cannot be loosened by project config.
- Effective config is locked at session/wrapper start.
- Config, prompt, integration, and package metadata changes are sensitive.
- Custom reviewers use structured `command` + `args`, `shell: false`, and
  allowlisted placeholders.
- Runtime re-verifies reviewer executable path, version, and capabilities.

### Round 3: Review Protocol Review

Findings addressed:

- Verdict replay could reuse stale pass results.
- Reviewer output could be malformed, partial, or mismatched.
- Diff content could prompt-inject reviewer instructions.
- Verdict blocks embedded inside diff content could be parsed incorrectly.

Design changes:

- Review jobs include `jobId`, `diffHash`, `configHash`, `promptHash`,
  reviewer identity, level, and required dimensions.
- Verdicts must match job metadata and include coverage.
- Cache key includes diff, config, prompt, reviewer, version, model, level, tool
  version, and privacy mode.
- Diffs and repository content are explicitly untrusted data.
- Parser accepts only the final top-level verdict block.

### Round 4: Filesystem And Diff Review

Findings addressed:

- Shell/generator changes could happen without transcript edit-tool events.
- Files could change after review starts.
- Symlinks, path traversal, submodules, worktrees, renames, binary files, large
  diffs, and generated files could hide reviewable changes.

Design changes:

- Filesystem/git baseline diff is authoritative; transcript paths are only
  supplementary.
- Post-review freshness check invalidates stale verdicts.
- Paths are canonicalized relative to workspace root.
- Outside-root paths are blocked or treated as sensitive failures.
- Symlink target changes, submodule pointer changes, renames, binary metadata,
  generated runtime files, and truncation limitations are explicitly reviewable.

### Round 5: Privacy, Isolation, And Packaging Review

Findings addressed:

- External review could send secrets or proprietary code to another provider.
- Reviewer tools could edit files while reviewing.
- npm package install scripts or dependencies could create supply-chain risk.
- Wrapper/advisory modes could be oversold as hard enforcement.

Design changes:

- External review is controlled by privacy policy and local secret scanning.
- Reviewer adapters require read-only/no-edit mode for `enforced` and
  `strict-ci`.
- Package avoids install scripts and automatic downloader behavior.
- Installer and README must disclose enforcement levels and residual risks.

## Evidence Matrix

| Requirement | Design Evidence | Risk Register Evidence | Required Implementation Evidence |
|---|---|---|---|
| No clean-tree bypass | Baseline review scope and committed-session rule | Agent commits changes risk | Test committed-during-session diff is reviewed |
| No small-code bypass by default | `reviewScope: "all-code"` in enforced | Small code bypass risk | Test small code diff reviews in enforced |
| Reviewer outages fail closed by default | `onReviewerError: "block"` | External reviewer outage risk | Tests for timeout, non-zero, malformed output |
| Valid reviewer fail blocks | Runtime rules distinguish valid fail from operational failure | Valid external fail risk | Test fail does not fall back to self-review |
| Project config cannot weaken policy | User-level policy floor | Project config weakens user policy risk | Test project downgrade rejected |
| Same-session config tampering blocked | Effective config locked at start | Agent edits config/prompt risk | Test changed config evaluated under old policy |
| Custom command injection blocked | Structured args and `shell: false` | Custom reviewer command injection risk | Tests for shell=false and unknown placeholders |
| Pass cache cannot replay stale review | Full review cache key | Pass cache replay risk | Tests for cache invalidation dimensions |
| Prompt injection resisted | Prompt injection defense and final verdict parser | Diff prompt injection risk | Tests with malicious diff and embedded fake verdict |
| Stale verdict rejected | Post-review freshness check | Stale verdict risk | Test file changes after review invalidate verdict |
| Non-transcript file changes reviewed | Filesystem/git diff authoritative | Shell/generator risk | Test shell-created file is reviewed |
| Path escape blocked | Canonical path requirements | Symlink/path traversal risk | Symlink/outside-root tests |
| Large/binary/generated files handled | Diff handling requirements | Large/binary/generated risks | Truncation, binary, generated-file tests |
| External privacy controlled | Privacy policy and secret scan | External review privacy risk | Secret scan tests and docs |
| Reviewer cannot edit in strict modes | Reviewer isolation requirements | Reviewer can edit risk | Adapter capability tests |
| Wrapper limitations disclosed | Enforcement levels and residual risks | Wrapper limitations risks | README/installer output tests or snapshots |

## Release Gates

Implementation is not release-ready until all gates pass:

1. Unit tests cover every `Mitigated` risk in the risk register.
2. Integration tests cover at least Claude Code native hook, one wrapper host,
   one external reviewer, and `none` self-review.
3. Windows tests cover `.cmd` executable resolution and `\subagents\` paths.
4. Installer dry-run snapshots show every file path it would write.
5. `npm pack --dry-run` excludes legacy Python, tests, caches, local state, and
   transcripts.
6. README discloses enforcement levels, external-review privacy, secret scan
   limits, wrapper limits, and non-security-boundary status.
7. `doctor` reports host capability level, reviewer path/version, privacy mode,
   and whether current config is stricter or looser than user policy floor.
8. Strict/CI mode has a fail-closed test suite proving no advisory/manual path
   satisfies the gate.

## Residual Risks

The remaining accepted risks are outside the package's full control:

- Host tool ignores its own hook/plugin contract.
- Reviewer provider lies or misses bugs.
- Same-user attacker disables the plugin or edits user-level policy.
- Detached background processes can continue mutating files after wrapper
  quiescence checks.
- Secret scanning is best effort and not a DLP system.

These risks are acceptable only if prominently disclosed and not marketed as
solved by the package.

## Audit Conclusion

The current design has no intentionally open design risks in the risk register.
The remaining risks are trust-boundary limitations that must be disclosed. The
design is acceptable as the basis for an implementation plan, provided the plan
preserves the release gates above and maps every mitigated risk to tests.
