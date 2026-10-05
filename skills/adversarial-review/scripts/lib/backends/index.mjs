// Backend adapter registry, resolution, and execution orchestration.
import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';

import { runChild as defaultRunChild, resolveExecutable } from '../proc.mjs';
import { parseStructured } from '../validate.mjs';
import { writeFileAtomic as defaultWriteFileAtomic } from '../fsx.mjs';
import { isValidModel } from '../config.mjs';
import { ConfigError } from '../errors.mjs';

import * as claudeBackend from './claude.mjs';
import * as codexBackend from './codex.mjs';
import * as opencodeBackend from './opencode.mjs';
import * as geminiBackend from './gemini.mjs';
import * as customBackend from './custom.mjs';

export const BACKEND_NAMES = ['claude', 'codex', 'opencode', 'gemini', 'custom'];

const ADAPTERS = {
  claude: claudeBackend,
  codex: codexBackend,
  opencode: opencodeBackend,
  gemini: geminiBackend,
  custom: customBackend,
};

export {
  claudeBackend as claude,
  codexBackend as codex,
  opencodeBackend as opencode,
  geminiBackend as gemini,
  customBackend as custom,
};

/**
 * Resolve a backend name and executable from environment/configuration.
 *
 * @param {string} name
 * @param {object} [options]
 * @param {object} [options.config]
 * @param {object} [options.env]
 * @returns {Promise<{ name: string, exe: string, command?: string[] }>}
 */
export async function resolveBackend(name, { config = {}, env = process.env } = {}) {
  if (!BACKEND_NAMES.includes(name)) {
    throw new ConfigError(`Unknown backend: ${name}`);
  }

  if (name === 'custom') {
    const command = config?.backends?.custom?.command;
    if (!Array.isArray(command) || command.length === 0) {
      throw new ConfigError('custom backend requires config.backends.custom.command');
    }
    const exeName = command[0];
    const exe = await resolveExecutable(exeName, env);
    if (!exe) {
      throw new ConfigError(`Executable not found: ${exeName}`);
    }
    return { name: 'custom', exe, command };
  }

  // opencode has its own lookup: a .cmd wrapper on PATH adds flags opencode v2 rejects, so the
  // generic PATHEXT resolution is wrong for this backend (spec A1).
  if (name === 'opencode') {
    const { exe, searched } = await opencodeBackend.resolveOpencodeExe(config, env);
    if (!exe) {
      throw new ConfigError(`opencode executable not found. Searched: ${searched.join(', ')}`);
    }
    return { name, exe };
  }

  const exeName = config?.backends?.[name]?.exe || name;
  const exe = await resolveExecutable(exeName, env);
  if (!exe) {
    throw new ConfigError(`Executable not found on PATH: ${exeName}`);
  }
  return { name, exe };
}

/**
 * Reserve attempt n by creating its live log with exclusive create.
 * A final log without its live log comes from an older process, so that n is taken too.
 *
 * @param {string} callsDir
 * @param {string} base
 * @param {number} startN
 * @returns {Promise<number>}
 */
async function reserveAttempt(callsDir, base, startN) {
  for (let n = Math.max(1, startN); ; n++) {
    try {
      await fsPromises.access(path.join(callsDir, `${base}.a${n}.log`));
      continue;
    } catch {
      // free
    }
    try {
      await fsPromises.writeFile(path.join(callsDir, `${base}.a${n}.live.log`), '', { flag: 'wx' });
      return n;
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
  }
}

// The attempt number was reserved by its live log, so the final log takes the same n.
async function writeAttemptLogAt(callsDir, base, n, content) {
  await fsPromises.writeFile(path.join(callsDir, `${base}.a${n}.log`), content, { flag: 'wx' });
}

function safe(fn, arg) {
  if (typeof fn !== 'function') return;
  try {
    fn(arg);
  } catch {
    // reporting never breaks a call
  }
}

function attemptLogContent(cmd, args, childRes) {
  const exit = `${childRes.code !== null && childRes.code !== undefined ? childRes.code : ''}${
    childRes.signal ? ` (signal: ${childRes.signal})` : ''
  }${childRes.idled ? ' (idle)' : ''}`;
  return [
    '=== ARGV ===',
    JSON.stringify([cmd, ...(args || [])], null, 2),
    '=== EXIT CODE ===',
    exit,
    '=== STDOUT ===',
    childRes.stdout || '',
    '=== STDERR ===',
    childRes.stderr || '',
  ].join('\n');
}

async function readIfExists(file) {
  if (!file) return '';
  try {
    return await fsPromises.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

// At most 3 attempts over the whole model list (spec C6).
const MAX_ATTEMPTS = 3;

/**
 * Orchestrate a seat call over a model list, at most three attempts, with a live log per attempt.
 *
 * @param {object} call
 * @param {string} call.callId
 * @param {string} call.prompt
 * @param {object} [call.schema]
 * @param {string} call.root
 * @param {string} call.runDir
 * @param {string} call.cwd
 * @param {string} [call.model]
 * @param {string[]} [call.models] Model list; the first entry runs first. Defaults to [call.model].
 * @param {number} [call.round=1] Round number; every call file carries `.r<round>`.
 * @param {string} [call.effort]
 * @param {number} [call.timeoutMs]
 * @param {number} [call.idleMs] Idle deadline; applied only to a streaming attempt.
 * @param {number} [call.attemptBase=0]
 * @param {Function} [call.onEvent]
 * @param {object} options
 * @param {string|object} options.backend
 * @param {Function} [options.runChild]
 * @param {object} [options.fs]
 * @param {Function} [options.onAttempt] ({ attempt, model }) before each attempt starts.
 * @param {Function} [options.onStdout] ({ attempt, bytes }) per stdout chunk.
 * @param {Function} [options.onStalled] ({ attempt, model, idleMs, action }) after an idle kill.
 * @param {Function} [options.onFailover] ({ from, to, reason }) before an attempt with another model.
 * @param {Function} [options.laneFor] async (model) => lane, called before each attempt.
 * @returns {Promise<{ ok: boolean, value: any, raw: string, error: string|null, attempts: number, costTotal?: number|null, tokensTotal?: number|null, costComplete?: boolean, toolRefusals?: number, stepCount?: number, errorType?: string|null, model?: string|null }>}
 */
export async function runSeatCall(call, options = {}) {
  const models = Array.isArray(call.models) && call.models.length > 0 ? call.models : [call.model];
  for (const m of models) {
    if (m !== undefined && m !== null && !isValidModel(m)) {
      return {
        ok: false,
        value: null,
        raw: '',
        error: 'bad-model',
        attempts: 0,
      };
    }
  }

  const round = call.round ?? 1;
  if (!Number.isInteger(round) || round < 1) {
    throw new ConfigError(`call.round must be an integer >= 1: ${call.round}`);
  }

  let backendObj;
  let adapter;

  if (typeof options.backend === 'string') {
    const bName = options.backend;
    adapter = ADAPTERS[bName];
    if (!adapter) {
      throw new ConfigError(`Unknown backend: ${bName}`);
    }
    backendObj = await resolveBackend(bName, { config: options.config, env: options.env });
  } else if (options.backend && typeof options.backend === 'object') {
    const bName = options.backend.name;
    adapter = ADAPTERS[bName] || (options.backend.build && options.backend.extract ? options.backend : null);
    if (!adapter) {
      throw new ConfigError(`Unknown backend: ${bName}`);
    }
    backendObj = options.backend;
    if (!backendObj.exe && bName !== 'custom') {
      const resolved = await resolveBackend(bName, { config: options.config, env: options.env });
      backendObj = { ...backendObj, exe: resolved.exe };
    }
  } else {
    throw new ConfigError('Missing backend in runSeatCall');
  }

  const runChildFn = options.runChild || defaultRunChild;
  const writeFileFn = options.fs?.writeFileAtomic || defaultWriteFileAtomic;

  const callsDir = path.join(call.runDir, 'calls');
  await fsPromises.mkdir(callsDir, { recursive: true });

  const platform = options.platform || process.platform;
  const exe = backendObj.exe || backendObj.name;
  let isCmdShim = false;
  if (backendObj.isCmdShim !== undefined) {
    isCmdShim = Boolean(backendObj.isCmdShim);
  } else if (options.isCmdShim !== undefined) {
    isCmdShim = Boolean(options.isCmdShim);
  } else if (typeof exe === 'string') {
    const lower = exe.toLowerCase();
    isCmdShim = platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'));
  }

  const ctx = {
    exe,
    platform,
    isCmdShim,
    command: backendObj.command,
    config: options.config,
    env: options.env || process.env,
  };

  // One prompt file and one schema file per round, so a later round never overwrites them.
  const base = `${call.callId}.r${round}`;
  const promptPath = path.join(callsDir, `${base}.prompt.txt`);
  const schemaPath = path.join(callsDir, `${base}.schema.json`);
  if (call.prompt != null) {
    await writeFileFn(promptPath, String(call.prompt));
  }

  const streamingFn = backendObj.streaming || adapter.streaming;

  let attempts = 0;
  let modelIdx = 0;
  let schemaWritten = false;
  let currentPrompt = call.prompt;
  let currentPromptFile = promptPath;
  let pendingPromptChange = false;
  let lastError = null;
  const timeoutRetried = new Set();
  let lastRaw = '';
  let lastExtra = {
    costTotal: null,
    tokensTotal: null,
    costComplete: false,
    toolRefusals: 0,
    stepCount: 0,
    errorType: null,
    model: models[0] ?? null,
    events: [],
  };

  while (attempts < MAX_ATTEMPTS && modelIdx < models.length) {
    attempts++;
    const model = models[modelIdx];
    const n = await reserveAttempt(callsDir, base, (call.attemptBase || 0) + attempts);

    if (pendingPromptChange) {
      currentPromptFile = path.join(callsDir, `${base}.a${n}.prompt.txt`);
      await writeFileFn(currentPromptFile, String(currentPrompt));
      pendingPromptChange = false;
    }

    // A failover model of another provider needs its own lane home, so the lane follows the model.
    const lane = typeof options.laneFor === 'function' ? await options.laneFor(model) : call.lane;
    const attemptCall = {
      ...call,
      ...(lane ? { lane } : {}),
      model,
      prompt: currentPrompt,
      promptFile: currentPromptFile,
      schemaFile: schemaPath,
      outFile: path.join(callsDir, `${base}.a${n}.out.json`),
    };

    const built = adapter.build(attemptCall, ctx);

    if (!schemaWritten && call.schema != null && !built.files?.[schemaPath]) {
      await writeFileFn(schemaPath, JSON.stringify(call.schema, null, 2));
      schemaWritten = true;
    }
    if (built.files) {
      for (const [filePath, content] of Object.entries(built.files)) {
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        await writeFileFn(filePath, content);
      }
    }

    let spawnCmd;
    let spawnArgs;
    if (backendObj.name === 'custom') {
      if (Array.isArray(built.args) && built.args.length > 0) {
        spawnCmd = backendObj.exe || built.args[0];
        spawnArgs = built.args.slice(1);
      } else {
        spawnCmd = backendObj.exe;
        spawnArgs = [];
      }
    } else {
      spawnCmd = backendObj.exe || backendObj.name;
      spawnArgs = built.args || [];
    }

    // The opencode adapter already scrubbed the parent environment, so merging it back here
    // would undo the scrub and hand every secret to the lane.
    const childEnv =
      adapter === opencodeBackend
        ? { ...(built.env || {}) }
        : {
            ...(options.env || process.env),
            ...(backendObj.env || {}),
            ...(built.env || {}),
          };

    const streamingMode = typeof streamingFn === 'function' ? Boolean(streamingFn(attemptCall)) : false;

    const events = [];
    const onEventFn = call.onEvent || options.onEvent;
    const parser =
      typeof adapter.createEventParser === 'function'
        ? adapter.createEventParser((evt) => {
            events.push(evt);
            safe(onEventFn, evt);
          })
        : null;

    safe(options.onAttempt, { attempt: n, model });

    // The host reads this file while the call runs, so every chunk is written as it arrives.
    const live = fs.createWriteStream(path.join(callsDir, `${base}.a${n}.live.log`), { flags: 'a' });
    let bytes = 0;

    const childRes = await runChildFn({
      cmd: spawnCmd,
      args: spawnArgs,
      cwd: built.cwd || call.cwd,
      env: childEnv,
      stdin: currentPrompt,
      timeoutMs: call.timeoutMs,
      idleMs: streamingMode ? call.idleMs : undefined,
      onStdout: (chunk) => {
        live.write(chunk);
        bytes += chunk.length;
        safe(options.onStdout, { attempt: n, bytes });
        if (parser) parser.push(chunk);
      },
    });
    if (parser) parser.end();
    await new Promise((resolve) => live.end(resolve));
    await writeAttemptLogAt(callsDir, base, n, attemptLogContent(spawnCmd, spawnArgs, childRes));

    const summary = typeof adapter.summarizeEvents === 'function' ? adapter.summarizeEvents(events) : {};
    const extra = {
      costTotal: summary.costTotal ?? null,
      tokensTotal: summary.tokensTotal ?? null,
      costComplete: summary.costComplete ?? false,
      toolRefusals: summary.toolRefusals ?? 0,
      stepCount: summary.stepCount ?? 0,
      errorType: summary.errorType ?? null,
      model: model ?? null,
      // The canary judges the boundary from the refused tool calls, so the parsed events of
      // the returned attempt leave this function with the result.
      events,
    };

    const nextModel = models[modelIdx + 1];
    // A failover never retries the model that just failed, so the list advances by one.
    const moveOn = (reason) => {
      if (nextModel === undefined) return false;
      safe(options.onFailover, { from: model, to: nextModel, reason });
      modelIdx++;
      return true;
    };
    // The suffix retry belongs to a one-model list only (spec C6 rule 4), so a list that is
    // used up ends the call instead.
    const handleContract = (reason) => {
      if (moveOn('contract')) return false;
      if (models.length > 1) return true;
      currentPrompt = `${call.prompt}\n\nYour previous answer failed: ${reason}. Answer again with ONE fenced json block.`;
      pendingPromptChange = true;
      return false;
    };

    if (childRes.idled) {
      lastError = 'idle';
      lastExtra = { ...extra, errorType: 'idle' };
      const action = nextModel !== undefined ? 'failover' : attempts < MAX_ATTEMPTS ? 'retry' : 'dead';
      safe(options.onStalled, { attempt: n, model, idleMs: call.idleMs, action });
      moveOn('idle');
      continue;
    }

    if (childRes.timedOut || childRes.spawnError || childRes.code !== 0) {
      const kind = childRes.timedOut ? 'timeout' : childRes.spawnError ? 'spawn' : 'exit';
      lastError =
        kind === 'exit'
          ? `exit-${childRes.code !== null ? childRes.code : childRes.signal || 1}`
          : kind;
      lastExtra = { ...extra, errorType: kind === 'exit' ? extra.errorType : kind };
      if (moveOn(kind)) continue;
      // Each timeout costs the whole stage timeout, so one model gets one timeout retry at most.
      if (kind === 'timeout') {
        if (timeoutRetried.has(modelIdx)) break;
        timeoutRetried.add(modelIdx);
      }
      continue;
    }

    const outFileText = await readIfExists(built.outFile);
    const extracted = adapter.extract({ stdout: childRes.stdout, outFileText, events });

    if (extracted && typeof extracted === 'object' && extracted.error) {
      // A refusal and a missing model do not change on a second ask.
      const fatal = extracted.error === 'provider-refused' || extracted.error === 'not-found';
      lastError = extracted.error;
      lastExtra = { ...extra, errorType: extracted.error };
      if (fatal) break;
      if (handleContract(`${extracted.error}: ${extracted.message || ''}`)) break;
      continue;
    }

    const raw = extracted;
    const parseRes = parseStructured(raw, call.schema);
    if (parseRes.ok) {
      return {
        ok: true,
        value: parseRes.value,
        raw,
        error: null,
        attempts,
        ...extra,
      };
    }

    lastError = `parse: ${parseRes.error}`;
    lastRaw = raw;
    lastExtra = extra;
    if (handleContract(lastError)) break;
  }

  return {
    ok: false,
    value: null,
    raw: lastRaw,
    error: lastError || 'no-attempt',
    attempts,
    ...lastExtra,
  };
}
