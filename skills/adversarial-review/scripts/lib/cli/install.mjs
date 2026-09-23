// CLI subcommands for install and uninstall.
import { install, uninstall, ALLOWED_HOSTS } from '../install.mjs';
import { ConfigError } from '../errors.mjs';
import { LockBusyError } from '../lockfile.mjs';

export async function runInstallCommand(
  argv = [],
  {
    env = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
  } = {}
) {
  let args = [...argv];
  let isUninstall = false;

  if (args[0] === 'uninstall') {
    isUninstall = true;
    args = args.slice(1);
  } else if (args[0] === 'install') {
    isUninstall = false;
    args = args.slice(1);
  } else if (args.includes('uninstall') || args.includes('--v2-hooks')) {
    isUninstall = true;
    args = args.filter((a) => a !== 'uninstall');
  }

  let host = null;
  let project = false;
  let dryRun = false;
  let force = false;
  let adopt = false;
  let quotaHook = false;
  let v2Hooks = false;
  let global = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--host') {
      host = args[++i];
    } else if (arg.startsWith('--host=')) {
      host = arg.slice(7);
    } else if (arg === '--project') {
      project = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--adopt') {
      adopt = true;
    } else if (arg === '--quota-hook') {
      quotaHook = true;
    } else if (arg === '--v2-hooks') {
      v2Hooks = true;
    } else if (arg === '--global') {
      global = true;
    }
  }

  try {
    if (isUninstall) {
      if (!host && !v2Hooks) {
        stderr.write('Error: uninstall requires --host or --v2-hooks\n');
        return 2;
      }
      if (host && !ALLOWED_HOSTS.includes(host)) {
        stderr.write(`Error: unknown host "${host}". Allowed: ${ALLOWED_HOSTS.join(', ')}\n`);
        return 2;
      }
      const res = await uninstall({
        host,
        project,
        v2Hooks,
        global,
        env,
        cwd,
        dryRun,
      });

      if (dryRun) {
        for (const file of res.deleted) {
          stdout.write(`delete: ${file}\n`);
        }
        for (const file of res.kept) {
          stdout.write(`keep: ${file}\n`);
        }
      } else {
        stdout.write(`Uninstalled: deleted ${res.deleted.length} files, kept ${res.kept.length}\n`);
      }
      return 0;
    } else {
      if (!host) {
        stderr.write(`Error: install requires --host <${ALLOWED_HOSTS.join('|')}>\n`);
        return 2;
      }
      if (!ALLOWED_HOSTS.includes(host)) {
        stderr.write(`Error: unknown host "${host}". Allowed: ${ALLOWED_HOSTS.join(', ')}\n`);
        return 2;
      }
      const res = await install({
        host,
        project,
        dryRun,
        force,
        adopt,
        quotaHook,
        env,
        cwd,
      });

      if (dryRun) {
        for (const file of res.written) {
          stdout.write(`write: ${file}\n`);
        }
        for (const item of res.kept) {
          stdout.write(`keep: ${item.file} (${item.reason})\n`);
        }
      } else {
        stdout.write(`Installed: written ${res.written.length} files, adopted ${res.adopted.length}, kept ${res.kept.length}\n`);
      }
      return 0;
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof LockBusyError || err?.exitCode === 2) {
      stderr.write(`${err.message}\n`);
      return 2;
    }
    stderr.write(`${err?.message || err}\n`);
    return err?.exitCode || 3;
  }
}
