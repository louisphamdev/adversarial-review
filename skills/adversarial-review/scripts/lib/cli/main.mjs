// Main CLI command dispatcher (§18.1).
import { parseArgs } from './args.mjs';
import { runCommand } from './run.mjs';
import { statusCommand } from './status.mjs';
import { patchReviewCommand, verifyCommand } from './closing.mjs';
import { siftCommand } from './sift.mjs';
import { recommendCommand } from './recommend.mjs';
import { quotaCommand } from './quota.mjs';
import { modelsCommand } from './models.mjs';
import { hookCommand } from './hook.mjs';
import { doctorCommand } from './doctor.mjs';
import { ENGINE_VERSION } from '../version.mjs';
import { ConfigError, RunError } from '../errors.mjs';
import { LockBusyError } from '../lockfile.mjs';

function printHelp(stdout) {
  stdout.write(`adversarial-review v${ENGINE_VERSION} - Zero-dependency adversarial code review engine

Usage:
  adversarial-review run [--target P] [--base R] [--stage S] [--seats a,b] [--requirements-file F] [--backend B] [--route R] [--allow-gaps] [--until find] [--detach] [--resume D [--allow-drift]] [--json]
  adversarial-review status [<run-dir> | --latest] [--json]
  adversarial-review patch-review <run-dir> --plan <file> [--json]
  adversarial-review verify <run-dir> [--base <ref>] [--json]
  adversarial-review sift --material <file> --findings <file> [--out <file>] [--json]
  adversarial-review recommend [--target <path>] [--json]
  adversarial-review quota [--gate <threshold>] [--json]
  adversarial-review models [probe | bench] [--backend B] [--model M] [--limit N] [--json]
  adversarial-review hook quota | hook --host <host> --event <event>
  adversarial-review doctor [--probe]
  adversarial-review install --host <host> [--project] [--dry-run] [--force] [--adopt] [--quota-hook]
  adversarial-review uninstall --host <host> [--project] [--dry-run] | uninstall --v2-hooks [--global]
  adversarial-review --version
  adversarial-review --help
`);
}

export async function main(
  argv = [],
  {
    env = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
    stdin = process.stdin,
  } = {}
) {
  const io = { env, cwd, stdout, stderr, stdin };

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    stderr.write(`Error: ${err.message}\n`);
    return err.exitCode || 2;
  }

  const { command, flags, positionals } = parsed;

  if (command === 'help') {
    printHelp(stdout);
    return 0;
  }

  if (command === 'version') {
    stdout.write(`adversarial-review ${ENGINE_VERSION}\n`);
    return 0;
  }

  try {
    switch (command) {
      case 'run':
        return await runCommand(flags, positionals, io);

      case 'status':
        return await statusCommand(flags, positionals, io);

      case 'patch-review':
        return await patchReviewCommand(flags, positionals, io);

      case 'verify':
        return await verifyCommand(flags, positionals, io);

      case 'sift':
        return await siftCommand(flags, positionals, io);

      case 'recommend':
        return await recommendCommand(flags, positionals, io);

      case 'quota':
        return await quotaCommand(flags, positionals, io);

      case 'models':
        return await modelsCommand(flags, positionals, io);

      case 'hook':
        return await hookCommand(flags, positionals, io);

      case 'doctor':
        return await doctorCommand(flags, positionals, io);

      case 'install':
      case 'uninstall': {
        const { runInstallCommand } = await import('./install.mjs');
        return await runInstallCommand(argv, io);
      }

      default:
        stderr.write(`Unknown command: "${command}"\nRun 'adversarial-review --help' for usage.\n`);
        return 2;
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof LockBusyError || err.exitCode === 2) {
      stderr.write(`Error: ${err.message}\n`);
      return err.exitCode || 2;
    }
    if (err instanceof RunError || err.exitCode === 3) {
      stderr.write(`Run error: ${err.message}\n`);
      return err.exitCode || 3;
    }
    stderr.write(`Unexpected error: ${err.message || err}\n`);
    return err.exitCode || 3;
  }
}
