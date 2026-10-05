import path from 'node:path';
import fs from 'node:fs/promises';
import { runSeatCall } from './backends/index.mjs';

// Tool names that work in each lane (spec 3.1-A, section 12).
// Part D renders them into the prompt and refuses a prompt without them, so a name that the
// lane does not allow becomes a seat that asks for a tool it cannot use.

// A swarm lane allows no `git diff`, `git show`, or `git log`: A7 replaced them with one exact
// `git --version` rule, so no git command belongs in this list.
export const SWARM_LANE_TOOLS = Object.freeze(['read', 'glob', 'grep']);

const HOST = Object.freeze(['Read', 'Grep', 'Glob']);

export const HOST_LANE_TOOLS = Object.freeze({
  claude: HOST,
  codex: HOST,
  gemini: HOST,
  custom: HOST,
  opencode: SWARM_LANE_TOOLS,
});

/**
 * The list for the lane that answers a finder seat.
 *
 * @param {{ finderRoutesToSwarm: boolean, hostBackend?: string }} input
 * @returns {string[]} a copy, so a caller cannot change the exported list
 */
export function laneToolsFor({ finderRoutesToSwarm, hostBackend = 'claude' }) {
  return [...(finderRoutesToSwarm ? SWARM_LANE_TOOLS : HOST_LANE_TOOLS[hostBackend] || HOST)];
}

/**
 * One seat call in a sandbox profile, for probe, bench, research, and the canary.
 * The returned function takes the model, so a caller can run one profile over many models.
 *
 * @param {object} input
 * @returns {(model: string) => Promise<object>}
 */
export function makeLaneCall({
  config,
  env,
  runDir,
  cwd,
  mode = 'zen',
  xdgHome,
  stage = 'TABLE',
  schema,
  prompt,
  timeoutMs = 90000,
  callIdPrefix = 'lane',
  backend = 'opencode',
  runSeatCall: callSeat = runSeatCall,
}) {
  return async (model) => {
    await fs.mkdir(path.join(runDir, 'calls'), { recursive: true });
    return callSeat(
      {
        callId: `${callIdPrefix}-${String(model).replace(/[^A-Za-z0-9._-]/g, '_')}`,
        prompt,
        schema,
        root: cwd,
        runDir,
        cwd,
        model,
        timeoutMs,
        lane: { mode, cwd, xdgHome, stage },
      },
      { backend, config, env }
    );
  };
}
