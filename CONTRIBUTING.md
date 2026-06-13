# Contributing

Thanks for helping improve adversarial-review-gate.

## Requirements

- **Node.js >= 20.** No Python is required (the previous Python implementation
  has been fully replaced).
- The package has **zero runtime dependencies** and is pure ESM. Keep it that
  way: no new runtime deps without a strong reason.
- Tests use the built-in `node:test` runner. Comments are in English.

## Development workflow

```bash
npm test                 # run the full test suite (node --test)
npm run doctor           # print the gate's effective state (dry-run)
npm run pack:dry-run     # preview the published tarball contents
```

Keep all existing tests green. Behavior changes must come with a test that
covers the new behavior.

## Dev-mode soft note

When you work **on this repo**, the gate you are building would otherwise gate
your own commits. Put a project-level `.adversarial-review/config.json`
containing:

```json
{ "policy": { "mode": "soft" } }
```

so you do not hard-gate your own development. This file is **gitignored** in this
repo, so it stays local and is never committed. Use `enforced` everywhere else.

## Design and threat model

The gate's design intent, threat model, and enforcement semantics are documented
inline in the source (see `src/core/gate.js`, `src/core/verdict.js`, and the
hardening comments throughout) and summarized in the README's
**Residual Risks** and **Policy Modes** sections. Read those before making
non-trivial changes to the gate's behavior or enforcement.

## Before opening a PR

1. `npm test` is green.
2. `npm run pack:dry-run` lists only the intended files.
3. Docs (`README.md`, `SKILL.md`, `CHANGELOG.md`) updated for any user-facing
   change.
