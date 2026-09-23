#!/usr/bin/env node
import { main } from '../skills/adversarial-review/scripts/lib/cli/main.mjs';

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
});
