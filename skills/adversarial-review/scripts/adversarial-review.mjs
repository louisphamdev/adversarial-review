#!/usr/bin/env node
// Executable CLI entrypoint for adversarial-review (§18.1).
import { main } from './lib/cli/main.mjs';

const exitCode = await main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
});
process.exitCode = exitCode;
