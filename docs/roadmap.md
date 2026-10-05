# Roadmap

This file lists the work that is planned after version 3.1. Each item names the problem first, then the planned change.

## 3.2

### Reading set for each seat

A seat reads only the files that the material names. A defect that needs a caller or a test outside the material stays out of view. The planned change: the host adds the callers and the tests of each changed function to a reading set, and every seat gets the same set.

### One frozen material for all stages

`run`, `patch-review`, and `verify` each read the material again. A change to the tree between two stages changes what the table sees. The planned change: the run keeps one snapshot of the material, and each later stage reads the snapshot plus the declared delta.

### Edit gate before a ruling

A host can edit source because of a finding before the judge rules. The planned change: an optional host hook refuses an edit to a file in the material while a run has no ruling.

### Seat memory across runs

A seat repeats a finding that the judge refuted in an earlier run on the same code. The planned change: the run keeps the refuted findings for each file, and a seat gets them as known answers.

## Known limits in 3.1

- A seat can stop before it reads the whole diff. The result does not yet report the part that the seat did not read.
- The integrity check covers tracked files only. An untracked file that a lane changes is not detected.
- The 180-second target for a FIND seat on the swarm route is a target, not a measured guarantee.
