// CLI quota command (§19.3).
import { readQuota } from '../quota.mjs';
import { loadConfig } from '../config.mjs';
import { stateDir } from '../paths.mjs';

export async function quotaCommand(
  flags = {},
  positionals = [],
  { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}
) {
  const { config } = loadConfig({ env, flags, stderr });

  let threshold = typeof config?.quota?.threshold === 'number' ? config.quota.threshold : 80;
  if (flags.gate !== undefined) {
    const parsed = Number(flags.gate);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      stderr.write(`Invalid --gate value: "${flags.gate}". Expected number between 0 and 100.\n`);
      return 2;
    }
    threshold = parsed;
  }

  const quota = await readQuota({
    config,
    env,
    stateDir: stateDir(env),
  });

  if (flags.json) {
    stdout.write(JSON.stringify(quota) + '\n');
  } else {
    if (quota.percent === null) {
      stdout.write(`Quota unknown (source: ${quota.source})\n`);
    } else {
      stdout.write(
        `Quota: ${quota.percent}% (source: ${quota.source}${quota.stale ? ', stale' : ''})\n`
      );
    }
  }

  if (quota.percent === null) {
    return 3;
  }

  return quota.percent >= threshold ? 1 : 0;
}
