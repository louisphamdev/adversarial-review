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

## Release Steps

The version is in two files: `package.json` for npm and `.claude-plugin/plugin.json` for Claude Code. The marketplace entry has no version.

1. Set the same new version in `package.json` and `.claude-plugin/plugin.json`.
2. Add the release to `CHANGELOG.md`.
3. Run `npm test`, `npm run build:check`, and `claude plugin validate --strict .`.
4. Commit the change and push it to `main`.
5. Make sure that CI is green on Linux, Windows, and macOS.
6. Run `claude plugin tag --push .`. This command makes sure that the plugin and the marketplace agree, then pushes the tag `adversarial-review--v<version>`.
7. Run `npm publish`.
8. Create a GitHub release from the tag. The release starts the GitHub Packages workflow.

If you do not change the version, Claude Code does not offer the update to users.

## Threat Model and Safety

The roundtable treats all material as untrusted data.
Never permit reviewer seats to write to repository files or run arbitrary shell commands.
Keep tool permissions restricted.

## Pull Request Checklist

Make sure that you complete these steps before opening a pull request:

1. All tests pass with `npm test`.
2. The package preview lists only intended files with `npm run pack:dry-run`.
3. Documentation files describe your changes.
