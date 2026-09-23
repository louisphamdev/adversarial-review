// CLI hook command for Claude Code PreToolUse quota hook and legacy v2 hooks (§19.5).
import { readQuota } from '../quota.mjs';
import { loadConfig } from '../config.mjs';
import { stateDir } from '../paths.mjs';

export async function hookCommand(
  flags = {},
  positionals = [],
  { env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin } = {}
) {
  try {
    // Legacy v2 form: hook --host <host> --event <event>
    if (flags.host || flags.event) {
      if (stderr?.write) {
        stderr.write(
          "v2 hook is deprecated and no longer active. Run 'adversarial-review uninstall --v2-hooks' to remove it.\n"
        );
      }
      stdout.write('{}\n');
      return 0;
    }

    const sub = positionals[0];
    if (sub === 'quota') {
      // Consume stdin if present (ignore errors)
      if (stdin && typeof stdin.read === 'function') {
        try {
          stdin.read();
        } catch {}
      }

      let config = {};
      try {
        const loaded = loadConfig({ env, flags, stderr });
        config = loaded.config;
      } catch {
        stdout.write('{}\n');
        return 0;
      }

      const threshold = typeof config?.quota?.threshold === 'number' ? config.quota.threshold : 80;
      const quota = await readQuota({
        config,
        env,
        stateDir: stateDir(env),
      });

      if (quota.percent !== null && quota.percent >= threshold) {
        const payload = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: `quota at ${quota.percent}%: consider adversarial-review run --route swarm`,
          },
        };
        stdout.write(JSON.stringify(payload) + '\n');
      } else {
        stdout.write('{}\n');
      }
      return 0;
    }

    stdout.write('{}\n');
    return 0;
  } catch {
    try {
      stdout.write('{}\n');
    } catch {}
    return 0;
  }
}
