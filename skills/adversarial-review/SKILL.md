---
name: adversarial-review
description: Adversarial review for spec, plan, code, and debug stages. Specialist seats find defects alone and attack findings before a judge rules. Triggers include "roundtable", "adversarial review", "bàn tròn", and "review đối kháng". Do not use this skill for one-line changes or trivial edits.
---

# Adversarial Review

Specialist seats review the same material from distinct lenses.
Seats attack findings in an open table.
A clean-context judge rules on surviving items.
Never fix before the ruling.

## When to Convene

Convene the table when mistakes carry high cost:

- A spec or design about to become an implementation plan.
- An implementation plan about to become code.
- A code change that touches security, data persistence, or shared contracts.
- A debug investigation where multiple hypotheses compete.

Do not convene the table for a one-line change, a rename, or trivial edits.

## Route Choice

Select the route with these three steps:

1. If the user named a route, or the user config sets `route` to `spawn` or `swarm`, use it.
2. Else run `recommend`. If the user config sets `routeAsk` to `false`, run with `--route auto`.
3. Else ask the user the `question` text as ONE question, and run the route that the user picks.

## Running the Review

Run the review with this command:

```bash
node "<skill-dir>/scripts/adversarial-review.mjs" run --backend <your own CLI>
```

Replace `<skill-dir>` with the path to this skill directory.
Always pass your own host backend via `--backend`, such as `--backend claude`, `--backend codex`, or `--backend opencode`.

You can also pass:
- `--stage <spec|plan|code|debug>`: sets the review stage.
- `--target <path>`: limits review to a specific target file or directory.
- `--json`: writes machine-readable output to stdout.

## Reading result.json

The run outputs state and results into `<state>/runs/<run-id>/result.json`.
Inspect these fields in `result.json`:

- `gateVerdict`: contains `PASS` or `BLOCK`.
- `closing list`: items that require fixes before merge.
- `gaps`: lists uncovered lenses or dead seats.

If `gateVerdict` is `BLOCK`, you must address every blocking finding in the closing list.

## Stage PATCH REVIEW and Stage VERIFY

After the judge delivers the ruling, resolve findings through two gates:

1. Stage PATCH REVIEW:
   Write a plan for your edits without modifying files.
   Run `adversarial-review patch-review <run-dir> --plan <file>`.
   Proceed with edits only when the judge approves the plan.

2. Stage VERIFY:
   After you make edits, run `adversarial-review verify <run-dir>`.
   Seats make sure that the changes meet each `doneWhen` condition.
   The judge returns a final PASS or BLOCK verdict.

## Live Table

On Claude Code with agent teams enabled, you can run a live interactive debate.
Read `references/live-table.md` for live table protocol details.
