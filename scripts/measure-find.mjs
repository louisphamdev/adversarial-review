// Measures one FIND seat on a zen free model through the full lane (spec 3.1-A, A14).
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createSandbox, writeProfileConfig, removeSandbox, PROFILE_STEPS } from '../skills/adversarial-review/scripts/lib/sandbox.mjs';
import { buildContextPack } from '../skills/adversarial-review/scripts/lib/pack.mjs';
import { runSeatCall } from '../skills/adversarial-review/scripts/lib/backends/index.mjs';
import { killAllTrackedSync } from '../skills/adversarial-review/scripts/lib/proc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = path.join(here, '..', 'test', 'fixtures', 'measure');
const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'opencode/big-pickle';
const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-measure-'));
try {
  const repoRoot = path.join(fx, 'material');
  const files = await fs.readdir(repoRoot);
  const materialPath = path.join(repoRoot, files[0]);
  const material = { kind: 'file', path: materialPath, text: await fs.readFile(materialPath, 'utf8') };
  const { treeDir } = await createSandbox({ repoRoot, runDir, material, config: {} });
  const pack = await buildContextPack({ material, treeDir, repoRoot, packChars: 60000 });
  const { cwd } = await writeProfileConfig({ runDir, profileKey: 'weak-find', treeDir, steps: PROFILE_STEPS['weak-find'] });
  const { buildPrompt } = await import('../skills/adversarial-review/scripts/lib/prompts.mjs');
  const { loadSeats } = await import('../skills/adversarial-review/scripts/lib/seats.mjs');
  const { SWARM_LANE_TOOLS } = await import('../skills/adversarial-review/scripts/lib/lane.mjs');
  // The seat prompt comes from prompts.mjs so that the tools block and the pack of part D are measured.
  const prompt = buildPrompt('FIND', {
    seat: { ...loadSeats().get('edge'), capability: 'weak', contextPack: await fs.readFile(pack.path, 'utf8') },
    tools: [...SWARM_LANE_TOOLS],
    materialPath: path.join(treeDir, files[0]),
    repoRoot: treeDir,
    budget: 20,
    reviewStage: 'code',
  });
  const t0 = Date.now();
  const r = await runSeatCall(
    { callId: 'measure-find', prompt, root: treeDir, runDir, cwd, model, timeoutMs: 600000, lane: { mode: 'zen', cwd, stage: 'FIND' } },
    { backend: 'opencode', config: {}, env: process.env }
  );
  const wall = (Date.now() - t0) / 1000;
  console.log(`wall=${wall.toFixed(1)} steps=${r.stepCount} refusals=${r.toolRefusals} ok=${r.ok} model=${model}`);
  process.exitCode = wall <= 180 && r.ok ? 0 : 1;
} finally {
  killAllTrackedSync();
  await removeSandbox(runDir);
  // The opencode service holds the profile cwd for a moment after the lane ends, so a bare rm
  // throws EBUSY on Windows and the uncaught error would replace the measured line and its exit
  // code. The retry mirrors `removeSandbox`; a directory left behind is reported, never thrown.
  for (let i = 0; ; i++) {
    try {
      await fs.rm(runDir, { recursive: true, force: true });
      break;
    } catch (err) {
      if (i === 4) {
        console.log(`note: could not delete ${runDir}: ${err.code || err.message}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
