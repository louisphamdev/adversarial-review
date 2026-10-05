// Fixtures for the run command: a resumable run directory, and a backend stub that changes the
// repository while a seat call is in flight.
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runsDir } from '../../skills/adversarial-review/scripts/lib/paths.mjs';
import { SCHEMA_VERSION, ENGINE_VERSION } from '../../skills/adversarial-review/scripts/lib/version.mjs';

const FAKE_SEAT_URL = pathToFileURL(path.resolve('test/fixtures/fake-seat.mjs')).href;

const HOST_STAGES = Object.freeze({
  find: 'host',
  table: 'host',
  dispute: 'host',
  lastcall: 'host',
  patchSeats: 'host',
  verifySeats: 'host',
  ruling: 'host',
  patchJudge: 'host',
  verifyJudge: 'host',
});

// Writes the `custom` host backend into the isolated user config. With `editFile`, the stub
// appends a line to that file before it answers, which is what a seat that edits the repository
// looks like from the engine's side.
export async function writeStubBackend({ home, editFile }) {
  const stateDir = path.join(home, '.adversarial-review');
  await fs.mkdir(stateDir, { recursive: true });
  const stub = path.join(home, 'stub-seat.mjs');
  const body = editFile
    ? `import fs from 'node:fs/promises';\n` +
      `await fs.appendFile(${JSON.stringify(editFile)}, 'edited by the stub\\n');\n` +
      `await import(${JSON.stringify(FAKE_SEAT_URL)});\n`
    : `await import(${JSON.stringify(FAKE_SEAT_URL)});\n`;
  await fs.writeFile(stub, body);

  const configPath = path.join(stateDir, 'config.json');
  let config = { version: 3 };
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch {
    // No user config yet.
  }
  config.version = 3;
  config.hostBackend = 'custom';
  config.backends = { ...(config.backends || {}), custom: { command: [process.execPath, stub] } };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return { stub, configPath };
}

export async function makeEditingStubBackend({ editFile, home }) {
  const { stub } = await writeStubBackend({ home, editFile });
  // The edit path is baked into the stub source: a backend call scrubs secret-shaped
  // environment names, so an env variable is not a reliable channel into the stub.
  return { env: {}, stub };
}

/**
 * A run directory that `run --resume` can pick up: a request, a material snapshot, and the
 * subdirectories a seat call needs.
 *
 * @param {object} input
 * @param {object} input.env isolated environment, used for the state directory
 * @param {string} input.home isolated home
 * @param {boolean} [input.baselineWritten] record a written integrity baseline in the request
 * @param {boolean} [input.withoutLaneTools] omit `request.lane`, as a run of schema 1 did
 * @param {boolean} [input.stubBackend] configure the custom stub backend, so the resume finishes
 * @returns {Promise<string>} the run directory
 */
export async function createResumableRunFixture({
  env,
  home,
  baselineWritten = false,
  withoutLaneTools = false,
  stubBackend = false,
  seatModels = {},
}) {
  // Inside the isolated home, so cleanup() of that home removes it too.
  const repoRoot = path.join(home, 'fixture-repo');
  await fs.mkdir(repoRoot, { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'subject.js'), 'export const a = 1;\n');

  const base = runsDir(env, repoRoot);
  await fs.mkdir(base, { recursive: true });
  const runDir = path.join(base, '20260101T000000Z-fixture');
  for (const sub of ['cwd', 'stages', 'calls', 'integrity']) {
    await fs.mkdir(path.join(runDir, sub), { recursive: true });
  }

  const text = 'export const a = 1;\n';
  await fs.writeFile(path.join(runDir, 'material.txt'), text);

  const request = {
    runId: path.basename(runDir),
    target: 'subject.js',
    base: 'HEAD',
    stage: 'code',
    seats: ['breaker'],
    noSeat: [],
    budget: 20,
    requirements: '',
    allowGaps: true,
    // The material lives only in the run directory, so drift is not what these cases measure.
    allowDrift: true,
    route: { route: 'spawn', reason: 'fixture', stages: { ...HOST_STAGES }, seatModels },
    backend: stubBackend ? 'custom' : 'claude',
    swarmBackend: 'opencode',
    materialHash: 'fixture',
    materialKind: 'file',
    materialPath: path.join(runDir, 'material.txt'),
    repoRoot,
    material: { kind: 'file', path: path.join(repoRoot, 'subject.js'), targetPath: 'subject.js', root: repoRoot, base: 'HEAD', text },
    integrity: { baselineWritten },
    engineVersion: ENGINE_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };
  if (!withoutLaneTools) request.lane = { tools: ['Read', 'Grep', 'Glob'] };

  await fs.writeFile(path.join(runDir, 'request.json'), JSON.stringify(request, null, 2) + '\n');

  if (baselineWritten) {
    await fs.writeFile(path.join(runDir, 'integrity', 'baseline.json'), JSON.stringify({ files: {} }));
    await fs.writeFile(path.join(runDir, 'integrity', 'state.json'), JSON.stringify({ keepSandbox: false, integrityChanged: false }));
  }
  if (stubBackend) await writeStubBackend({ home });

  return runDir;
}

/**
 * A fake `opencode` on PATH that records every invocation and can break its own sandbox.
 *
 * The body is the `fake-opencode.mjs` fixture, copied beside the JSON that configures it. It is
 * an ES module behind a launcher, because the single-file executable of `makeFakeBins` is
 * CommonJS on POSIX and ESM on Windows, and this body needs `node:fs`.
 *
 * @param {object} input
 * @param {string} input.dir a directory already on the test PATH, from makeFakeBins
 * @param {string[]} [input.models] what `opencode models` prints
 * @param {string} [input.logFile] every argv line is appended here, one call per line
 * @param {boolean} [input.escapeSandbox] write the canary target the prompt names, which is what
 *   a lane whose permission boundary does not hold looks like from the engine's side
 * @returns {Promise<{ logFile: string|undefined }>}
 */
export async function writeSwarmBin({ dir, models = [], logFile, escapeSandbox = false }) {
  const impl = path.join(dir, 'fake-opencode.mjs');
  await fs.copyFile(path.resolve('test/fixtures/fake-opencode.mjs'), impl);
  await fs.writeFile(
    path.join(dir, 'fake-opencode.json'),
    JSON.stringify({ models, logFile: logFile || null, escapeSandbox, version: 'opencode v2.0.9' })
  );

  if (process.platform === 'win32') {
    await fs.writeFile(
      path.join(dir, 'opencode.cmd'),
      `@"${process.execPath}" "%~dp0fake-opencode.mjs" %*\r\n`
    );
  } else {
    const launcher = path.join(dir, 'opencode');
    await fs.writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`);
    await fs.chmod(launcher, 0o755);
  }
  return { logFile };
}

// A store that already holds a lens tier for every lens seat of the stage, so `research` has
// nothing to measure and the run reaches the route decision without a bench call. A swarm model
// counts as training, so the user config acknowledges that unless the case measures the refusal.
export async function seedModelStore({ home, model, lenses, callable = true, acknowledgeTraining = true }) {
  const stateDir = path.join(home, '.adversarial-review');
  await fs.mkdir(stateDir, { recursive: true });
  const configPath = path.join(stateDir, 'config.json');
  let config = { version: 3 };
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch {
    // No user config yet.
  }
  config.version = 3;
  config.swarm = { ...(config.swarm || {}), acknowledgeTraining };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  const entry = {
    backend: 'opencode',
    model,
    callable,
    contract: true,
    latencyMs: 100,
    measuredAt: Date.now(),
    lenses: Object.fromEntries(lenses.map((l) => [l, 'top'])),
  };
  await fs.writeFile(
    path.join(stateDir, 'models.json'),
    JSON.stringify({ version: 4, [`opencode:${model}`]: entry }, null, 2)
  );
}
