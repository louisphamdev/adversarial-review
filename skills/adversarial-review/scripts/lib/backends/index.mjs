// Backend adapter registry, resolution, and execution orchestration.
import path from 'node:path';
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

  const exeName = config?.backends?.[name]?.exe || name;
  const exe = await resolveExecutable(exeName, env);
  if (!exe) {
    throw new ConfigError(`Executable not found on PATH: ${exeName}`);
  }
  return { name, exe };
}

/**
 * Write attempt log exclusively, incrementing n on EEXIST.
 *
 * @param {string} callsDir
 * @param {string} callId
 * @param {number} startN
 * @param {string} content
 * @returns {Promise<{ n: number, logPath: string }>}
 */
async function writeAttemptLog(callsDir, callId, startN, content) {
  let n = startN;
  while (true) {
    const logPath = path.join(callsDir, `${callId}.a${n}.log`);
    try {
      await fsPromises.writeFile(logPath, content, { flag: 'wx' });
      return { n, logPath };
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        n++;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Orchestrate a seat call across up to two attempts with log recording.
 *
 * @param {object} call
 * @param {string} call.callId
 * @param {string} call.prompt
 * @param {object} [call.schema]
 * @param {string} call.root
 * @param {string} call.runDir
 * @param {string} call.cwd
 * @param {string} [call.model]
 * @param {string} [call.effort]
 * @param {number} [call.timeoutMs]
 * @param {number} [call.attemptBase=0]
 * @param {object} options
 * @param {string|object} options.backend
 * @param {Function} [options.runChild]
 * @param {object} [options.fs]
 * @param {Function} [options.log]
 * @returns {Promise<{ ok: boolean, value: any, raw: string, error: string|null, attempts: number }>}
 */
export async function runSeatCall(call, options = {}) {
  if (call.model !== undefined && call.model !== null && !isValidModel(call.model)) {
    return {
      ok: false,
      value: null,
      raw: '',
      error: 'bad-model',
      attempts: 0,
    };
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
  };

  const built = adapter.build(call, ctx);

  let promptPath = null;
  if (call.prompt != null) {
    promptPath = path.join(callsDir, `${call.callId}.prompt.txt`);
    await writeFileFn(promptPath, String(call.prompt));
  }
  const schemaPath = path.join(callsDir, `${call.callId}.schema.json`);
  if (call.schema != null && !built.files?.[schemaPath]) {
    await writeFileFn(schemaPath, JSON.stringify(call.schema, null, 2));
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

  const childEnv = {
    ...(options.env || process.env),
    ...(backendObj.env || {}),
    ...(built.env || {}),
  };

  let attempts = 0;
  let lastN = call.attemptBase || 0;
  let currentPrompt = call.prompt;

  while (attempts < 2) {
    attempts++;
    const targetN = Math.max(lastN + 1, (call.attemptBase || 0) + attempts);

    if (attempts > 1 && promptPath) {
      await writeFileFn(promptPath, currentPrompt);
    }

    const childRes = await runChildFn({
      cmd: spawnCmd,
      args: spawnArgs,
      cwd: call.cwd,
      env: childEnv,
      stdin: currentPrompt,
      timeoutMs: call.timeoutMs,
    });

    const logContent = [
      '=== ARGV ===',
      JSON.stringify([spawnCmd, ...spawnArgs], null, 2),
      '=== EXIT CODE ===',
      `${childRes.code !== null ? childRes.code : ''}${childRes.signal ? ` (signal: ${childRes.signal})` : ''}`,
      '=== STDOUT ===',
      childRes.stdout || '',
      '=== STDERR ===',
      childRes.stderr || '',
    ].join('\n');

    const { n: writtenN } = await writeAttemptLog(callsDir, call.callId, targetN, logContent);
    lastN = writtenN;

    if (childRes.timedOut) {
      return {
        ok: false,
        value: null,
        raw: '',
        error: 'timeout',
        attempts,
      };
    }

    if (childRes.spawnError) {
      return {
        ok: false,
        value: null,
        raw: '',
        error: 'spawn',
        attempts,
      };
    }

    if (childRes.code !== 0) {
      const exitErr = `exit-${childRes.code !== null ? childRes.code : (childRes.signal || 1)}`;
      if (attempts === 1) {
        currentPrompt = `${call.prompt}\n\nYour previous answer failed: ${exitErr}. Answer again with ONE fenced json block.`;
        continue;
      }
      return {
        ok: false,
        value: null,
        raw: '',
        error: exitErr,
        attempts: 2,
      };
    }

    let outFileText = '';
    if (built.outFile) {
      try {
        outFileText = await fsPromises.readFile(built.outFile, 'utf8');
      } catch {
        outFileText = '';
      }
    }

    const raw = adapter.extract({ stdout: childRes.stdout, outFileText });
    const parseRes = parseStructured(raw, call.schema);

    if (parseRes.ok) {
      return {
        ok: true,
        value: parseRes.value,
        raw,
        error: null,
        attempts,
      };
    }

    const parseErr = `parse: ${parseRes.error}`;
    if (attempts === 1) {
      currentPrompt = `${call.prompt}\n\nYour previous answer failed: ${parseErr}. Answer again with ONE fenced json block.`;
      continue;
    }

    return {
      ok: false,
      value: null,
      raw,
      error: parseErr,
      attempts: 2,
    };
  }
}
