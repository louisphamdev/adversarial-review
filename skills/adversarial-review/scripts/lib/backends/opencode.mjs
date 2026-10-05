// OpenCode backend adapter.
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { resolveExecutable, getEnvCaseInsensitive, accessExists } from '../proc.mjs';

export const name = 'opencode';

/**
 * A .cmd wrapper on PATH can add flags opencode rejects (measured: --yolo), so the .exe wins.
 * Keep the final PATHEXT lookup: a wrapper still beats no executable at all (spec A1 step 3).
 */
export async function resolveOpencodeExe(
  config = {},
  env = process.env,
  { platform = process.platform, exists = accessExists } = {}
) {
  const searched = [];
  const configured = config?.backends?.opencode?.exe;
  if (configured) return { exe: configured, searched: [configured] };

  if (platform === 'win32') {
    const p = path.win32;
    const entries = String(getEnvCaseInsensitive(env, 'PATH') || '')
      .split(';')
      .filter((d) => d && p.isAbsolute(d));
    for (const dir of entries) {
      const candidate = p.join(dir, 'opencode.exe');
      searched.push(candidate);
      if (await exists(candidate)) return { exe: candidate, searched };
    }
    const home = getEnvCaseInsensitive(env, 'USERPROFILE');
    if (home) {
      const fixed = p.join(home, '.opencode', 'bin', 'opencode.exe');
      searched.push(fixed);
      if (await exists(fixed)) return { exe: fixed, searched };
    }
  }

  const exe = await resolveExecutable('opencode', env, { platform, exists });
  searched.push('PATH:opencode');
  return { exe, searched };
}

const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/**
 * The lane environment is the parent environment minus every secret-shaped name.
 * No variable is added back (spec A8).
 *
 * @param {object} [env]
 * @returns {object}
 */
export function scrubEnv(env = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k)) out[k] = v;
  return out;
}

/**
 * A zen free model answers inside the opencode service, so the lane needs no agent and no
 * config of its own: the permission profile in the lane cwd is the read-only boundary. A named
 * model of another provider needs its provider block, which lives in an isolated XDG home with
 * the `ar-seat` agent.
 *
 * The tools block and the context pack come from prompts.mjs (spec section 12), so stdin
 * carries the seat prompt alone.
 */
export function build(call, ctx = {}) {
  const lane = call.lane || { mode: 'zen', cwd: call.cwd, stage: 'FIND' };
  const env = scrubEnv(ctx.env || process.env);
  const modelArg = call.model ? ['-m', call.model] : [];
  const args =
    lane.mode === 'named'
      ? ['run', '--standalone', '--format', 'json', '--auto', '--agent', 'ar-seat', ...modelArg]
      : ['run', '--format', 'json', '--auto', ...modelArg];
  // A named lane with no isolated home keeps the parent value: an `XDG_CONFIG_HOME` of
  // `undefined` would reach the child as the text "undefined" and point at nothing.
  if (lane.mode === 'named' && lane.xdgHome) env.XDG_CONFIG_HOME = lane.xdgHome;

  // `opencode run` takes its session directory from `root ?? process.env.PWD ?? process.cwd()`
  // and has no flag for it, so an inherited PWD beats the cwd below: the lane would load the
  // engine's project config instead of the profile, and every permission rule of A7 would be inert.
  if (lane.cwd) {
    env.PWD = lane.cwd;
    delete env.OLDPWD;
  }

  return { args, env, cwd: lane.cwd, stdin: call.prompt ?? '', files: {} };
}

/**
 * Split a stdout byte stream into newline-delimited JSON events.
 * The decoder carries a partial multi-byte character across chunks.
 *
 * @param {Function} onEvent
 * @returns {{ push: (chunk: Buffer|string) => void, end: () => void }}
 */
export function createEventParser(onEvent) {
  const decoder = new StringDecoder('utf8');
  let carry = '';

  const emit = (line) => {
    const t = line.trim();
    if (!t) return;
    let evt;
    try {
      evt = JSON.parse(t);
    } catch {
      return;
    }
    try {
      onEvent(evt);
    } catch {
      // listener errors are ignored
    }
  };

  return {
    push(chunk) {
      carry += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let i;
      while ((i = carry.indexOf('\n')) >= 0) {
        emit(carry.slice(0, i));
        carry = carry.slice(i + 1);
      }
    },
    end() {
      carry += decoder.end();
      emit(carry);
      carry = '';
    },
  };
}

function errorTypeOf({ status, message = '' }) {
  if (status === 401 || status === 403) return 'provider-refused';
  if (status === 429 || /rate.?limit/i.test(message)) return 'rate-limited';
  if (status === 404 || /not found/i.test(message)) return 'not-found';
  return 'bad-output';
}

/**
 * Reduce a parsed event list to the cost, token, refusal, step, and error facts.
 *
 * @param {object[]} [events]
 * @returns {{ costTotal: number, tokensTotal: number, costComplete: boolean, toolRefusals: number, stepCount: number, errorType: string|null, errorMessage: string|null, status: number|null }}
 */
export function summarizeEvents(events = []) {
  let costTotal = 0;
  let tokensTotal = 0;
  let stepFinishes = 0;
  let costComplete = true;
  let toolRefusals = 0;
  let stepCount = 0;
  let errorType = null;
  let errorMessage = null;
  let status = null;

  for (const e of events) {
    if (e?.type === 'step_start') stepCount++;
    if (e?.type === 'step_finish') {
      stepFinishes++;
      const c = e.part?.cost;
      if (typeof c === 'number' && Number.isFinite(c)) costTotal += c;
      else costComplete = false;
      const t = e.part?.tokens || {};
      tokensTotal += (Number(t.input) || 0) + (Number(t.output) || 0) + (Number(t.reasoning) || 0);
    }
    if (e?.type === 'tool_use' && e.part?.state?.status === 'error') {
      const msg = String(e.part.state.error || '');
      if (/Permission denied|external_directory/i.test(msg)) toolRefusals++;
    }
    if (e?.type === 'error') {
      status = e.error?.status ?? null;
      errorMessage = String(e.error?.message || '');
      errorType = errorTypeOf({ status, message: errorMessage });
    }
  }

  // No step_finish means no cost was reported at all, so the total is not complete.
  if (stepFinishes === 0) costComplete = false;

  return { costTotal, tokensTotal, costComplete, toolRefusals, stepCount, errorType, errorMessage, status };
}

/**
 * The answer is the text of the last assistant message. With no parsed event,
 * the raw stdout is the answer.
 *
 * @param {{ stdout?: string, events?: object[] }} [input]
 * @returns {string|{ error: string, status?: number|null, message: string }}
 */
export function extract({ stdout = '', events = [] } = {}) {
  const errEvt = [...events].reverse().find((e) => e?.type === 'error');
  if (errEvt) {
    const s = summarizeEvents([errEvt]);
    return { error: s.errorType, status: s.status, message: s.errorMessage };
  }
  if (events.length === 0) return stdout || '';

  const ids = events.map((e) => e?.messageID).filter(Boolean);
  const last = ids[ids.length - 1];
  const parts = events.filter(
    (e) => e?.messageID === last && e.type === 'text' && e.part?.type === 'text'
  );
  if (parts.length === 0) return { error: 'bad-output', message: 'step cap reached' };

  const text = parts.map((e) => e.part.text || '').join('');
  if (!text.trim()) return { error: 'empty-answer', message: 'the last message has no text' };
  return text;
}
