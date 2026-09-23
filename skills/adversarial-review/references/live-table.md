# Live Table Protocol

This document defines the live table protocol for interactive host environments with agent teams.
Specialist seats review the same material and debate in the open.
A clean-context judge rules on surviving findings.

## The Seats

Each seat owns one specialist lens:

| Seat | Lens | Model Tier |
|---|---|---|
| `rt-breaker` | Logic defects | strong |
| `rt-edge` | Hostile and boundary input | standard |
| `rt-attacker` | Security boundaries and trust | strong |
| `rt-racer` | Concurrency and async lifecycle | strong |
| `rt-plumber` | Resource leaks and performance | standard |
| `rt-keeper` | Data integrity and schemas | strong |
| `rt-medic` | Error handling and rollbacks | standard |
| `rt-tester` | Test suite coverage | standard |
| `rt-native` | Platform and operating system reality | standard |
| `rt-historian` | Requirements and contracts | standard |
| `rt-simplifier` | Redundant complexity (advisory) | standard |
| `rt-skeptic` | Cross-examination and seam defects | standard |
| `rt-judge` | Final ruling with clean context | strong |

Invite four to six seats for typical reviews.
`rt-skeptic` must attend every review.
`rt-judge` must close every review.

## Finding Format

Seats record findings with these fields:
- `evidence`: file and line reference, or an exact quote.
- `severity`: critical, important, or minor.
- `doneWhen`: objective condition tested without asking the author.

## Stages

The live table runs these stages in order:

### 1. FIND

Each seat reads the material alone.
Seats must not communicate during this stage.
Every seat submits its findings to the lead.

### 2. TABLE

The lead shares all findings with all active seats.
Seats inspect claims from other lenses.
Seats dispute flawed findings and identify cross-lens defects.

### 3. DISPUTE

The lead assigns pairs of seats to argue contested claims.
Limit discussions to two turns per dispute.
Unresolved disputes advance directly to the judge.

### 4. LAST CALL

The lead asks every seat for missing observations.
Seats declare any remaining defects.
After this stage, the review scope freezes.

### 5. RULING

Spawn `rt-judge` with clean context.
The judge evaluates all surviving findings and disputes.
The judge returns a ruling with the closing list and gate verdict.
Never fix code before the ruling finishes.

### 6. PATCH REVIEW

The author writes a comprehensive patch plan before editing code.
Relevant seats evaluate the plan.
Seats make sure that the plan satisfies their `doneWhen` conditions.
Seats make sure that fixes do not introduce regressions in their lens.
The judge approves the plan before edits begin.

### 7. VERIFY

After the author modifies files, seats inspect the resulting diff.
Seats review only their own reported findings.
Each seat answers whether its `doneWhen` condition is met.
Do not reopen settled ground outside the diff.
The judge issues the final PASS or BLOCK verdict.

## Closing the Table

Keep all seats active until stage VERIFY returns PASS.
After the user accepts the review result, record method mistakes.
Seats record method mistakes to `~/.adversarial-review/memory/rt-<seat>.md`.
Do not record project details or file paths in memory.
Shut down all seats after recording completes.
