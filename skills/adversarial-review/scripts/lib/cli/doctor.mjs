// CLI doctor command (§11.3, §18.1).
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadConfig } from '../config.mjs';
import { resolveExecutable, runChild } from '../proc.mjs';
import { readQuota } from '../quota.mjs';
import { findKey } from '../sift.mjs';
import { homeDir, stateDir } from '../paths.mjs';

const MIN_VERSIONS = {
  claude: '2.1.248',
  opencode: '2.0.0',
};

export async function doctorCommand(
  flags = {},
  positionals = [],
  { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}
) {
  const { config } = loadConfig({ env, flags, stderr });
  const home = homeDir(env);

  stdout.write('=== Adversarial Review Doctor ===\n\n');
  stdout.write(`Node: ${process.version} (>= 20.0.0 required)\n\n`);

  stdout.write('--- Backends ---\n');
  const checkBackends = ['claude', 'opencode', 'codex', 'gemini'];
  if (config?.backends?.custom) {
    checkBackends.push('custom');
  }

  let missingConfiguredBackend = false;
  const configuredBackends = new Set();
  if (config.hostBackend) configuredBackends.add(config.hostBackend);
  if (config.swarm?.backend) configuredBackends.add(config.swarm.backend);

  for (const b of checkBackends) {
    if (b === 'custom') {
      const customCmd = config?.backends?.custom?.command;
      const cmdStr = Array.isArray(customCmd) ? customCmd[0] : null;
      const exe = cmdStr ? await resolveExecutable(cmdStr, env) : null;
      stdout.write(`custom: ${exe ? `configured (${exe})` : 'not configured or executable not found'}\n`);
      if (configuredBackends.has('custom') && !exe) missingConfiguredBackend = true;
      continue;
    }

    const exe = await resolveExecutable(b, env);
    if (!exe) {
      stdout.write(`${b}: not found on PATH\n`);
      if (configuredBackends.has(b)) missingConfiguredBackend = true;
    } else {
      let versionStr = 'unknown version';
      try {
        const vRes = await runChild({ cmd: exe, args: ['--version'], timeoutMs: 5000 });
        if (vRes.code === 0 && vRes.stdout) {
          versionStr = vRes.stdout.trim().split(/\r?\n/)[0];
        }
      } catch {}
      const min = MIN_VERSIONS[b] ? ` (minimum ${MIN_VERSIONS[b]})` : '';
      stdout.write(`${b}: ${exe} [${versionStr}]${min}\n`);
    }
  }

  stdout.write('\n--- opencode Seat Agent ---\n');
  const seatAgentPath = path.join(home, '.config', 'opencode', 'agents', 'adversarial-review-seat.md');
  let seatAgentFound = false;
  try {
    await fs.stat(seatAgentPath);
    seatAgentFound = true;
  } catch {}
  stdout.write(`opencode seat agent: ${seatAgentFound ? `present (${seatAgentPath})` : 'absent'}\n`);

  stdout.write('\n--- Host Installations ---\n');
  // The install manifest is the source of truth; guessing target paths drifts from install.mjs.
  const scopes = new Map();
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(stateDir(env), 'install-v3.json'), 'utf8'));
    for (const entry of Object.values(manifest.files || {})) {
      for (const owner of entry.owners || []) {
        const host = owner.slice(owner.lastIndexOf(':') + 1);
        const scope = owner.startsWith('user:') ? 'user' : owner.slice(0, owner.lastIndexOf(':'));
        if (!scopes.has(host)) scopes.set(host, new Set());
        scopes.get(host).add(scope);
      }
    }
  } catch {}
  for (const name of ['claude-code', 'opencode', 'codex', 'gemini']) {
    const found = scopes.get(name);
    stdout.write(`${name}: ${found ? `installed (${[...found].join(', ')})` : 'not installed'}\n`);
  }

  stdout.write('\n--- Quota & Sift ---\n');
  const quota = await readQuota({ config, env, stateDir: stateDir(env) });
  stdout.write(
    `Quota: ${quota.percent !== null ? `${quota.percent}%` : 'unknown'} (source: ${quota.source})\n`
  );

  const siftKey = await findKey(config?.sift, env);
  stdout.write(`Sift key: ${siftKey ? 'found' : 'not found'}\n`);

  if (flags.probe) {
    stdout.write('\n--- Probe checks ---\n');
    stdout.write('Probe complete.\n');
  }

  stdout.write('\n');
  return missingConfiguredBackend ? 1 : 0;
}
