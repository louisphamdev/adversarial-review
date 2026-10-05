// CLI doctor command (§11.3, §18.1, spec 3.1-A A13).
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { loadConfig } from '../config.mjs';
import { resolveExecutable, runChild } from '../proc.mjs';
import { readQuota } from '../quota.mjs';
import { findKey } from '../sift.mjs';
import { homeDir, stateDir } from '../paths.mjs';
import { resolveOpencodeExe } from '../backends/opencode.mjs';
import { PROFILE_STEPS, removeSandbox, writeProfileConfig } from '../sandbox.mjs';
import { readLock, pidAlive } from '../lockfile.mjs';
import { readStore } from '../catalog.mjs';
import { makeLaneCall } from '../lane.mjs';
import { runCanary } from '../canary.mjs';
import { laneCap, readMachine } from '../lanes.mjs';

const MIN_VERSIONS = {
  claude: '2.1.248',
  opencode: '2.0.0',
};

// The lane boundary depends on opencode 2.x permission rules, so a 1.x binary is not a warning.
const SUPPORTED_OPENCODE_MAJOR = 2;

// The sandbox is a file copy plus a permission profile, never an OS boundary. This line names
// what a reader could still put the lane inside; it does not claim the lane uses it.
async function detectOsIsolation(env) {
  if (await resolveExecutable('docker', env)) return 'docker';
  const wsl = await resolveExecutable('wsl', env);
  if (wsl) {
    try {
      const res = await runChild({ cmd: wsl, args: ['--status'], timeoutMs: 5000 });
      if (res.code === 0) return 'wsl';
    } catch {}
  }
  return 'none';
}

// A run holds its own sandbox keys. Any other run directory left one behind, so doctor deletes it.
async function removeStaleSandboxKeys(env) {
  const runs = path.join(stateDir(env), 'runs');
  let removed = 0;
  let held = 0;
  let repoDirs = [];
  try {
    repoDirs = await fs.readdir(runs, { withFileTypes: true });
  } catch {
    return { removed, held };
  }
  for (const repo of repoDirs) {
    if (!repo.isDirectory()) continue;
    let runDirs = [];
    try {
      runDirs = await fs.readdir(path.join(runs, repo.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of runDirs) {
      if (!entry.isDirectory()) continue;
      const runDir = path.join(runs, repo.name, entry.name);
      try {
        await fs.stat(path.join(runDir, 'sandbox', 'xdg'));
      } catch {
        continue;
      }
      const lock = await readLock(path.join(runDir, 'lock'));
      if (lock && pidAlive(lock.pid)) {
        held++;
        continue;
      }
      // `keep` leaves the tree: only the key directory is state that outlived its run.
      await removeSandbox(runDir, { keep: true, log: () => {} });
      removed++;
    }
  }
  return { removed, held };
}

// The fastest model the store proved callable. The canary measures the boundary, not the model,
// so latency is the only ranking that matters here.
function fastestCallableModel(store, backend) {
  return Object.entries(store)
    .filter(([key, value]) => key !== 'version' && value && typeof value === 'object')
    .filter(([key, value]) => value.callable === true && (value.backend || key.split(':')[0]) === backend)
    .map(([, value]) => value)
    .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity))[0]?.model || null;
}

async function probeCanary({ config, env, stdout, backend }) {
  const model = fastestCallableModel(await readStore(stateDir(env)), backend);
  if (!model) {
    stdout.write('canary: no callable model stored (run "adversarial-review models probe" first)\n');
    return;
  }
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-doctor-'));
  try {
    const treeDir = path.join(runDir, 'sandbox', 'tree');
    await fs.mkdir(treeDir, { recursive: true });
    const { cwd, xdgHome } = await writeProfileConfig({
      runDir,
      profileKey: 'canary',
      treeDir,
      steps: PROFILE_STEPS.canary,
    });
    const res = await runCanary({
      runDir,
      repoRoot: treeDir,
      treeDir,
      profiles: [{ profileKey: 'canary', cwd, xdgHome, mode: 'zen' }],
      models: [model],
      laneCallFor: ({ cwd: laneCwd, mode, xdgHome: laneXdgHome, prompt }) =>
        makeLaneCall({
          config,
          env,
          runDir,
          cwd: laneCwd,
          mode,
          xdgHome: laneXdgHome,
          stage: 'FIND',
          prompt,
          timeoutMs: 180000,
          callIdPrefix: 'canary',
          backend,
        }),
    });
    stdout.write(`canary: ${res.result} (${model})\n`);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

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
  let unsupportedOpencode = false;
  const swarmBackend = config.swarm?.backend || 'opencode';
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

    // A .cmd wrapper on PATH rejects flags the engine sends, so opencode has its own lookup (A1).
    const exe = b === 'opencode' ? (await resolveOpencodeExe(config, env)).exe : await resolveExecutable(b, env);
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
      if (b === 'opencode' && swarmBackend === 'opencode') {
        // An unreadable version says nothing about the major: only a parsed number can fail here.
        const major = versionStr.match(/(\d+)\.\d+\.\d+/)?.[1];
        if (major !== undefined && Number(major) !== SUPPORTED_OPENCODE_MAJOR) {
          stdout.write(`opencode: major version ${major} is not supported (need ${SUPPORTED_OPENCODE_MAJOR}.x)\n`);
          unsupportedOpencode = true;
        }
      }
    }
  }

  // The installer stopped writing this file. A copy from an earlier install is listed, not used.
  const seatAgentPath = path.join(home, '.config', 'opencode', 'agents', 'adversarial-review-seat.md');
  try {
    await fs.stat(seatAgentPath);
    stdout.write(`opencode seat agent (v1, unused): present (${seatAgentPath})\n`);
  } catch {}

  stdout.write('\n--- Lane isolation ---\n');
  stdout.write('isolation: sandbox copy + permission profile\n');
  stdout.write('lanes: standalone, isolated config (no global MCP, instructions, or plugins)\n');
  stdout.write(`os-isolation: ${await detectOsIsolation(env)}\n`);
  const machine = readMachine();
  const { parts } = laneCap({ machine, config, callsReady: Infinity });
  const maxParallel = Number.isFinite(parts.maxParallel) ? parts.maxParallel : 'none';
  stdout.write(
    `lane cap: ${Math.min(parts.ramCap, parts.cpuCap, parts.maxParallel)} (ramCap ${parts.ramCap}, cpuCap ${parts.cpuCap}, maxParallel ${maxParallel}; memory ${machine.freeRamMb} MB)\n`
  );
  const stale = await removeStaleSandboxKeys(env);
  stdout.write(
    `stale sandbox/xdg removed: ${stale.removed}${stale.held ? ` (${stale.held} held by a live run)` : ''}\n`
  );

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
    await probeCanary({ config, env, stdout, backend: swarmBackend });
    stdout.write('Probe complete.\n');
  }

  stdout.write('\n');
  return missingConfiguredBackend || unsupportedOpencode ? 1 : 0;
}
