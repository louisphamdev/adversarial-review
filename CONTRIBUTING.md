# Contributing

Thank you for contributing to adversarial-review.

## Requirements

- Node.js version 20 or newer.
- The package uses pure ECMAScript Modules (ESM).
- Tests use the built-in `node:test` test runner.
- Write code comments and documentation in English.

## Development Workflow

Run tests with Node.js:

```bash
npm test
```

Run the doctor command to inspect your environment:

```bash
npm run doctor
```

Preview package contents before publication:

```bash
npm run pack:dry-run
```

All existing tests must pass.
When you change behavior, you must add a test for the new behavior.

## Threat Model and Safety

The roundtable treats all material as untrusted data.
Never permit reviewer seats to write to repository files or run arbitrary shell commands.
Keep tool permissions restricted.

## Pull Request Checklist

Make sure that you complete these steps before opening a pull request:

1. All tests pass with `npm test`.
2. The package preview lists only intended files with `npm run pack:dry-run`.
3. Documentation files describe your changes.
