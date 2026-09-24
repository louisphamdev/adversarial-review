# adversarial-review

[![npm](https://img.shields.io/npm/v/adversarial-review-gate.svg)](https://www.npmjs.com/package/adversarial-review-gate)
[![CI](https://github.com/louisphamdev/adversarial-review/actions/workflows/ci.yml/badge.svg)](https://github.com/louisphamdev/adversarial-review/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/adversarial-review-gate.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/adversarial-review-gate.svg)](https://nodejs.org)

Multi-agent adversarial review roundtable for coding agents.

The roundtable organizes an adversarial debate between specialist review seats.
Each seat inspects material through an independent lens and challenges findings from other seats.
A finding survives only when it defeats counter-arguments.
A clean-context judge delivers the final ruling.

## When to Convene

Use the roundtable when an incorrect decision causes high rework costs:

- Specifications and architecture designs
- Multi-step implementation plans
- Complex code changes and pull requests
- Root-cause investigations for difficult bugs

Do not use the roundtable for one-line changes or routine questions.

## Supported Hosts

The installer configures adversarial-review for these agent hosts:

- Claude Code (`claude-code`)
- OpenCode (`opencode`)
- Codex (`codex`)
- Gemini CLI (`gemini`)

## Install

The npm package is [`adversarial-review-gate`](https://www.npmjs.com/package/adversarial-review-gate).
The package gives one command: `adversarial-review`.

CAUTION: With `npx`, always type the full package name `adversarial-review-gate`. The npm name `adversarial-review` alone belongs to a different package.

Install the command globally:

```bash
npm install -g adversarial-review-gate
adversarial-review --version
```

You can also run each command without an install:

```bash
npx adversarial-review-gate --version
```

The same package is on GitHub Packages as `@louisphamdev/adversarial-review-gate`.

For Claude Code, you can use the plugin instead:

```
/plugin marketplace add louisphamdev/adversarial-review
/plugin install adversarial-review@adversarial-review
```

The examples below use the global command. If you use `npx`, write `npx adversarial-review-gate` in place of `adversarial-review`.

To install the skill for your host:

```bash
adversarial-review install --host claude-code
```

To install the skill for a different host:

```bash
adversarial-review install --host opencode
```

To inspect your configuration and tools:

```bash
adversarial-review doctor
```

## Remove Version 2 Hooks

Version 3 removes the automatic background hooks from version 2.
If you used version 2, remove the legacy hooks from your settings:

```bash
adversarial-review uninstall --v2-hooks
```

If you installed version 2 globally, include the global flag:

```bash
adversarial-review uninstall --v2-hooks --global
```

## How to Run

### 1. Select a Route

The roundtable provides two execution routes:

- `spawn`: Runs sub-agents with your current host CLI.
- `swarm`: Runs parallel lanes across headless coding agents.

To receive an automatic recommendation, run:

```bash
adversarial-review recommend
```

The command evaluates your quota and diff size, then recommends `spawn` or `swarm`.

### 2. Execute the Review

To run the roundtable on your current repository diff:

```bash
adversarial-review run --route auto
```

You can choose a specific route directly:

```bash
adversarial-review run --route spawn
```

To review a specific specification or plan file, pass the target path:

```bash
adversarial-review run --target docs/spec.md
```

### 3. Read the Results

The run produces a `result.json` file in the run state directory.
Inspect these fields:

- `gateVerdict`: Displays `PASS` or `BLOCKED`.
- `closingList`: Lists all defects that you must fix before merge.
- `gaps`: Lists files and areas that seats did not inspect.

Never fix defects before the ruling.
Wait until the judge issues the final verdict before you write code changes.

## Review Stages

The roundtable advances through seven structured stages:

1. `FIND`: Seats inspect the material independently. Seats do not share initial findings.
2. `TABLE`: The lead compiles all findings and shares them with the full table.
3. `DISPUTE`: Paired seats debate contested claims.
4. `LAST CALL`: Seats state any final concerns before the scope freezes.
5. `RULING`: A fresh judge reviews surviving claims and issues the gate verdict.
6. `PATCH REVIEW`: Seats evaluate proposed code patches against their conditions.
7. `VERIFY`: Seats inspect the final diff lines to make sure that the fixes resolve the defects.

## License

MIT
