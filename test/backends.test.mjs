import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  BACKEND_NAMES,
  resolveBackend,
  runSeatCall,
} from '../skills/adversarial-review/scripts/lib/backends/index.mjs';
import * as claudeBackend from '../skills/adversarial-review/scripts/lib/backends/claude.mjs';
import * as codexBackend from '../skills/adversarial-review/scripts/lib/backends/codex.mjs';
import * as opencodeBackend from '../skills/adversarial-review/scripts/lib/backends/opencode.mjs';
import * as geminiBackend from '../skills/adversarial-review/scripts/lib/backends/gemini.mjs';
import * as customBackend from '../skills/adversarial-review/scripts/lib/backends/custom.mjs';

import { FINDINGS, strictify } from '../skills/adversarial-review/scripts/lib/schemas.mjs';
import { ConfigError } from '../skills/adversarial-review/scripts/lib/errors.mjs';

test('backends module: BACKEND_NAMES', () => {
  assert.deepEqual(BACKEND_NAMES, ['claude', 'codex', 'opencode', 'gemini', 'custom']);
});

test('backends module: module exports shape', () => {
  const modules = [
    claudeBackend,
    codexBackend,
    opencodeBackend,
    geminiBackend,
    customBackend,
  ];
  for (const mod of modules) {
    assert.equal(typeof mod.name, 'string');
    assert.equal(typeof mod.build, 'function');
    assert.equal(typeof mod.extract, 'function');
  }
});

test('Golden argv: claude backend', () => {
  const call = {
    callId: 'c1',
    prompt: 'review this',
    schema: FINDINGS,
    root: '/repo/root',
    runDir: '/state/runs/run-1',
    cwd: '/state/runs/run-1/cwd',
    model: 'claude-3-7-sonnet',
    effort: 'high',
    timeoutMs: 10000,
  };

  const linuxBuilt = claudeBackend.build(call, { platform: 'linux', isCmdShim: false });
  assert.deepEqual(linuxBuilt.args, [
    '-p',
    '--restricted',
    '--safe-mode',
    '--strict-mcp-config',
    '--tools',
    'Read',
    'Grep',
    'Glob',
    '--allowedTools',
    'Read',
    'Grep',
    'Glob',
    '--permission-mode',
    'dontAsk',
    '--add-dir',
    call.root,
    '--add-dir',
    call.runDir,
    '--output-format',
    'json',
    '--model',
    'claude-3-7-sonnet',
    '--effort',
    'high',
    '--json-schema',
    JSON.stringify(FINDINGS),
  ]);

  const shimBuilt = claudeBackend.build(call, { platform: 'win32', isCmdShim: true });
  assert.deepEqual(shimBuilt.args, [
    '-p',
    '--restricted',
    '--safe-mode',
    '--strict-mcp-config',
    '--tools',
    'Read',
    'Grep',
    'Glob',
    '--allowedTools',
    'Read',
    'Grep',
    'Glob',
    '--permission-mode',
    'dontAsk',
    '--add-dir',
    call.root,
    '--add-dir',
    call.runDir,
    '--output-format',
    'json',
    '--model',
    'claude-3-7-sonnet',
    '--effort',
    'high',
  ]);
  assert.equal(shimBuilt.args.includes('--json-schema'), false);
});

test('Golden argv: codex backend', () => {
  const call = {
    callId: 'call-42',
    prompt: 'review this code',
    schema: FINDINGS,
    root: '/repo/root',
    runDir: '/state/runs/run-1',
    cwd: '/state/runs/run-1/cwd',
    model: 'o3-mini',
    effort: 'medium',
    timeoutMs: 10000,
  };

  const schemaFile = path.join(call.runDir, 'calls', 'call-42.schema.json');
  const outFile = path.join(call.runDir, 'calls', 'call-42.out.json');

  const built = codexBackend.build(call, { platform: 'linux' });
  assert.deepEqual(built.args, [
    'exec',
    '--sandbox',
    'read-only',
    '--ask-for-approval',
    'never',
    '--ephemeral',
    '--skip-git-repo-check',
    '-c',
    'mcp_servers={}',
    '-C',
    call.cwd,
    '--output-schema',
    schemaFile,
    '-o',
    outFile,
    '-m',
    'o3-mini',
    '-c',
    'model_reasoning_effort=medium',
    '-',
  ]);
  assert.equal(built.outFile, outFile);
  assert.deepEqual(JSON.parse(built.files[schemaFile]), strictify(FINDINGS));
});

test('Golden argv: opencode backend', () => {
  const call = {
    callId: 'c1',
    prompt: 'review this code',
    schema: FINDINGS,
    root: '/repo/root',
    runDir: '/state/runs/run-1',
    cwd: '/state/runs/run-1/cwd',
    model: 'anthropic/claude-3-5-sonnet',
    effort: 'high',
    timeoutMs: 10000,
  };

  const built = opencodeBackend.build(call, { platform: 'linux' });
  assert.deepEqual(built.args, [
    'run',
    '--auto',
    '--agent',
    'adversarial-review-seat',
    '-m',
    'anthropic/claude-3-5-sonnet#high',
  ]);
  assert.deepEqual(
    JSON.parse(built.env.OPENCODE_CONFIG_CONTENT),
    {
      permission: {
        external_directory: {
          '*': 'deny',
          [`${call.root}/**`]: 'allow',
          [`${call.runDir}/**`]: 'allow',
        },
      },
    }
  );

  const callWithPreHash = { ...call, model: 'provider/m#medium' };
  const builtWithPreHash = opencodeBackend.build(callWithPreHash, {});
  assert.deepEqual(builtWithPreHash.args, [
    'run',
    '--auto',
    '--agent',
    'adversarial-review-seat',
    '-m',
    'provider/m#medium',
  ]);

  const callNoEffort = { ...call, effort: null };
  const builtNoEffort = opencodeBackend.build(callNoEffort, {});
  assert.deepEqual(builtNoEffort.args, [
    'run',
    '--auto',
    '--agent',
    'adversarial-review-seat',
    '-m',
    'anthropic/claude-3-5-sonnet',
  ]);
});

test('opencode backend: normalizes Windows backslashes in permission globs', () => {
  const call = {
    callId: 'c1',
    prompt: 'review this code',
    schema: FINDINGS,
    root: 'C:\\Users\\alice\\repo',
    runDir: 'C:\\Users\\alice\\.adversarial-review\\runs\\r1',
    cwd: 'C:\\Users\\alice\\repo',
  };
  const built = opencodeBackend.build(call, { platform: 'win32' });
  const config = JSON.parse(built.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.permission.external_directory['C:/Users/alice/repo/**'], 'allow');
  assert.equal(config.permission.external_directory['C:/Users/alice/.adversarial-review/runs/r1/**'], 'allow');
});

test('Golden argv: gemini backend', () => {
  const call = {
    callId: 'c1',
    prompt: 'review this code',
    schema: FINDINGS,
    root: '/repo/root',
    runDir: '/state/runs/run-1',
    cwd: '/state/runs/run-1/cwd',
    model: 'gemini-2.5-pro',
    timeoutMs: 10000,
  };

  const settingsFile = path.join(call.runDir, 'gemini-settings.json');
  const built = geminiBackend.build(call, { platform: 'linux' });
  assert.deepEqual(built.args, [
    '--approval-mode',
    'default',
    '--output-format',
    'json',
    '--include-directories',
    `${call.root},${call.runDir}`,
    '-m',
    'gemini-2.5-pro',
  ]);
  assert.equal(built.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, settingsFile);
  assert.deepEqual(JSON.parse(built.files[settingsFile]), {
    tools: {
      core: ['read_file', 'read_many_files', 'glob', 'search_file_content', 'list_directory'],
    },
    mcpServers: {},
  });
});

test('Golden argv: custom backend', () => {
  const call = {
    callId: 'c1',
    prompt: 'review this code',
    schema: FINDINGS,
    root: '/repo/root',
    runDir: '/state/runs/run-1',
    cwd: '/state/runs/run-1/cwd',
    model: 'my-custom-model',
  };
  const config = {
    backends: {
      custom: {
        command: [
          'my-tool',
          '--prompt',
          '{promptFile}',
          '--schema',
          '{schemaFile}',
          '--out',
          '{outFile}',
          '--root',
          '{root}',
          '--cwd',
          '{cwd}',
          '--m',
          '{model}',
        ],
      },
    },
  };

  const promptFile = path.join(call.runDir, 'calls', 'c1.prompt.txt');
  const schemaFile = path.join(call.runDir, 'calls', 'c1.schema.json');
  const outFile = path.join(call.runDir, 'calls', 'c1.out.json');

  const built = customBackend.build(call, { config });
  assert.deepEqual(built.args, [
    'my-tool',
    '--prompt',
    promptFile,
    '--schema',
    schemaFile,
    '--out',
    outFile,
    '--root',
    call.root,
    '--cwd',
    call.cwd,
    '--m',
    'my-custom-model',
  ]);
  assert.equal(built.outFile, outFile);
});

test('extract behavior per backend', () => {
  assert.equal(
    claudeBackend.extract({
      stdout: JSON.stringify({ structured_output: { findings: [] } }),
    }),
    JSON.stringify({ findings: [] })
  );
  assert.equal(
    claudeBackend.extract({
      stdout: JSON.stringify({ result: 'plain result text' }),
    }),
    'plain result text'
  );

  assert.equal(
    codexBackend.extract({
      stdout: 'ignore stdout',
      outFileText: '{"findings":[]}',
    }),
    '{"findings":[]}'
  );

  assert.equal(
    opencodeBackend.extract({
      stdout: '```json\n{"findings":[]}\n```',
    }),
    '```json\n{"findings":[]}\n```'
  );

  assert.equal(
    geminiBackend.extract({
      stdout: JSON.stringify({ response: '```json\n{"findings":[]}\n```' }),
    }),
    '```json\n{"findings":[]}\n```'
  );

  assert.equal(
    customBackend.extract({
      stdout: 'fallback-stdout',
      outFileText: 'out-file-content',
    }),
    'out-file-content'
  );
  assert.equal(
    customBackend.extract({
      stdout: 'only-stdout',
      outFileText: undefined,
    }),
    'only-stdout'
  );
});

test('resolveBackend validation', async () => {
  await assert.rejects(
    () => resolveBackend('unknown-backend'),
    (err) => err instanceof ConfigError && err.message.includes('Unknown backend')
  );

  await assert.rejects(
    () => resolveBackend('nonexistent-binary-12345'),
    (err) => err instanceof ConfigError
  );

  await assert.rejects(
    () => resolveBackend('custom', { config: {} }),
    (err) => err instanceof ConfigError && err.message.includes('config.backends.custom.command')
  );

  await assert.rejects(
    () =>
      resolveBackend('custom', {
        config: { backends: { custom: { command: ['nonexistent-binary-99999'] } } },
      }),
    (err) => err instanceof ConfigError && err.message.includes('Executable not found')
  );

  const customResolved = await resolveBackend('custom', {
    config: {
      backends: {
        custom: {
          command: [process.execPath, 'test/fixtures/echo-seat.mjs'],
        },
      },
    },
  });
  assert.equal(customResolved.name, 'custom');
  assert.equal(customResolved.exe, process.execPath);
});

test('runSeatCall: bad-model rejects before spawn and writes no log', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });

    const call = {
      callId: 'bad-call',
      prompt: 'test prompt',
      schema: FINDINGS,
      root: tmp,
      runDir,
      cwd,
      model: '--x',
    };

    const res = await runSeatCall(call, {
      backend: { name: 'custom', exe: process.execPath, command: [process.execPath, 'test/fixtures/echo-seat.mjs'] },
    });

    assert.equal(res.ok, false);
    assert.equal(res.error, 'bad-model');
    assert.equal(res.attempts, 0);
    assert.equal(existsSync(path.join(runDir, 'calls', 'bad-call.a1.log')), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: custom backend running echo-seat -> ok, attempts === 1, log exists', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });

    const call = {
      callId: 'c1',
      prompt: 'echo prompt',
      schema: FINDINGS,
      root: tmp,
      runDir,
      cwd,
      model: 'test-model',
    };

    const backend = {
      name: 'custom',
      exe: process.execPath,
      command: [process.execPath, path.resolve('test/fixtures/echo-seat.mjs')],
    };

    const res = await runSeatCall(call, { backend });
    assert.equal(res.ok, true);
    assert.equal(res.attempts, 1);
    assert.deepEqual(res.value, { findings: [] });

    const logFile = path.join(runDir, 'calls', 'c1.a1.log');
    assert.equal(existsSync(logFile), true);

    const logContent = await readFile(logFile, 'utf8');
    assert.match(logContent, /argv/i);
    assert.match(logContent, /echo-seat\.mjs/);
    assert.equal(logContent.includes('echo prompt'), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: fake seat prints prose twice -> ok:false, error starts with parse, attempts === 2, two logs', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });

    const call = {
      callId: 'c-prose',
      prompt: 'prose prompt',
      schema: FINDINGS,
      root: tmp,
      runDir,
      cwd,
      model: 'test-model',
    };

    const backend = {
      name: 'custom',
      exe: process.execPath,
      command: [process.execPath, path.resolve('test/fixtures/backends/prose-seat.mjs')],
    };

    const res = await runSeatCall(call, { backend });
    assert.equal(res.ok, false);
    assert.equal(typeof res.error, 'string');
    assert.match(res.error, /^parse/);
    assert.equal(res.attempts, 2);

    assert.equal(existsSync(path.join(runDir, 'calls', 'c-prose.a1.log')), true);
    assert.equal(existsSync(path.join(runDir, 'calls', 'c-prose.a2.log')), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: fake seat exits 1 then succeeds -> ok, attempts 2', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });

    const stateFile = path.join(tmp, 'state.txt');
    const call = {
      callId: 'c-retry',
      prompt: 'retry prompt',
      schema: FINDINGS,
      root: tmp,
      runDir,
      cwd,
      model: 'test-model',
    };

    const backend = {
      name: 'custom',
      exe: process.execPath,
      command: [process.execPath, path.resolve('test/fixtures/backends/fail-once-seat.mjs')],
      env: { ...process.env, STATE_FILE: stateFile },
    };

    const res = await runSeatCall(call, { backend });
    assert.equal(res.ok, true);
    assert.equal(res.attempts, 2);
    assert.deepEqual(res.value, { findings: [] });

    assert.equal(existsSync(path.join(runDir, 'calls', 'c-retry.a1.log')), true);
    assert.equal(existsSync(path.join(runDir, 'calls', 'c-retry.a2.log')), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: timeoutMs: 200 seat sleeps -> ok:false, error: timeout, attempts: 1', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });

    const call = {
      callId: 'c-timeout',
      prompt: 'hang prompt',
      schema: FINDINGS,
      root: tmp,
      runDir,
      cwd,
      model: 'test-model',
      timeoutMs: 200,
    };

    const backend = {
      name: 'custom',
      exe: process.execPath,
      command: [process.execPath, path.resolve('test/fixtures/backends/sleep-seat.mjs')],
    };

    const res = await runSeatCall(call, { backend });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'timeout');
    assert.equal(res.attempts, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: attemptBase: 2 -> log a3', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });

    const call = {
      callId: 'c-base',
      prompt: 'base prompt',
      schema: FINDINGS,
      root: tmp,
      runDir,
      cwd,
      model: 'test-model',
      attemptBase: 2,
    };

    const backend = {
      name: 'custom',
      exe: process.execPath,
      command: [process.execPath, path.resolve('test/fixtures/echo-seat.mjs')],
    };

    const res = await runSeatCall(call, { backend });
    assert.equal(res.ok, true);
    assert.equal(res.attempts, 1);
    assert.equal(existsSync(path.join(runDir, 'calls', 'c-base.a3.log')), true);
    assert.equal(existsSync(path.join(runDir, 'calls', 'c-base.a1.log')), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: child process.cwd() equals call.cwd', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });

    const sideFile = path.join(tmp, 'cwd-recorded.txt');
    const call = {
      callId: 'c-cwd',
      prompt: 'cwd prompt',
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          cwd: { type: 'string' },
        },
        required: ['ok', 'cwd'],
      },
      root: tmp,
      runDir,
      cwd,
      model: 'test-model',
    };

    const backend = {
      name: 'custom',
      exe: process.execPath,
      command: [process.execPath, path.resolve('test/fixtures/backends/cwd-seat.mjs')],
      env: { ...process.env, CWD_RECORD_FILE: sideFile },
    };

    const res = await runSeatCall(call, { backend });
    assert.equal(res.ok, true);

    const recorded = (await readFile(sideFile, 'utf8')).trim();
    assert.equal(recorded, cwd);
    assert.equal(res.value.cwd, cwd);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: EEXIST log conflict advances to next available index', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const callsDir = path.join(runDir, 'calls');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(callsDir, { recursive: true });
    await mkdir(cwd, { recursive: true });

    // Pre-create c1.a1.log
    await writeFile(path.join(callsDir, 'c1.a1.log'), 'PRE-EXISTING CONTENT', 'utf8');

    const call = {
      callId: 'c1',
      prompt: 'echo prompt',
      schema: FINDINGS,
      root: tmp,
      runDir,
      cwd,
      model: 'test-model',
    };

    const backend = {
      name: 'custom',
      exe: process.execPath,
      command: [process.execPath, path.resolve('test/fixtures/echo-seat.mjs')],
    };

    const res = await runSeatCall(call, { backend });
    assert.equal(res.ok, true);
    assert.equal(res.attempts, 1);

    // Old log was untouched
    const oldLog = await readFile(path.join(callsDir, 'c1.a1.log'), 'utf8');
    assert.equal(oldLog, 'PRE-EXISTING CONTENT');

    // New log was written to a2.log
    assert.equal(existsSync(path.join(callsDir, 'c1.a2.log')), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: retry prompt appends exact error message on attempt 2', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });

    const capturedStdin = [];
    const fakeRunChild = async ({ stdin }) => {
      capturedStdin.push(stdin);
      if (capturedStdin.length === 1) {
        return {
          code: 0,
          signal: null,
          stdout: 'Invalid JSON answer from first attempt',
          stderr: '',
          timedOut: false,
          spawnError: null,
        };
      }
      return {
        code: 0,
        signal: null,
        stdout: '```json\n{"findings":[]}\n```',
        stderr: '',
        timedOut: false,
        spawnError: null,
      };
    };

    const call = {
      callId: 'c-retry-prompt',
      prompt: 'Initial prompt text',
      schema: FINDINGS,
      root: tmp,
      runDir,
      cwd,
      model: 'test-model',
    };

    const res = await runSeatCall(call, {
      backend: { name: 'custom', exe: process.execPath, command: [process.execPath] },
      runChild: fakeRunChild,
    });

    assert.equal(res.ok, true);
    assert.equal(res.attempts, 2);
    assert.equal(capturedStdin.length, 2);
    assert.equal(capturedStdin[0], 'Initial prompt text');
    assert.match(
      capturedStdin[1],
      /^Initial prompt text\n\nYour previous answer failed: parse: .*\. Answer again with ONE fenced json block\.$/
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: synchronizes prompt file on disk before launching attempt 2 (C5)', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });

    let attempt2PromptOnDisk = null;
    let callCount = 0;
    const promptPath = path.join(runDir, 'calls', 'c-sync-prompt.prompt.txt');
    const fakeRunChild = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          code: 0,
          signal: null,
          stdout: 'Prose with no json',
          stderr: '',
          timedOut: false,
          spawnError: null,
        };
      }
      attempt2PromptOnDisk = await readFile(promptPath, 'utf8');
      return {
        code: 0,
        signal: null,
        stdout: '```json\n{"findings":[]}\n```',
        stderr: '',
        timedOut: false,
        spawnError: null,
      };
    };

    const call = {
      callId: 'c-sync-prompt',
      prompt: 'Initial prompt text',
      schema: FINDINGS,
      root: tmp,
      runDir,
      cwd,
      model: 'test-model',
    };

    const res = await runSeatCall(call, {
      backend: { name: 'custom', exe: process.execPath, command: [process.execPath] },
      runChild: fakeRunChild,
    });

    assert.equal(res.ok, true);
    assert.equal(res.attempts, 2);
    assert.ok(attempt2PromptOnDisk, 'prompt file on disk should be read on attempt 2');
    assert.match(
      attempt2PromptOnDisk,
      /^Initial prompt text\n\nYour previous answer failed: parse: .*\. Answer again with ONE fenced json block\.$/
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: injected runChild with backend string resolves and runs', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });

    let capturedCall;
    const fakeRunChild = async (opts) => {
      capturedCall = opts;
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify({ structured_output: { findings: [] } }),
        stderr: '',
        timedOut: false,
        spawnError: null,
      };
    };

    const call = {
      callId: 'c-claude',
      prompt: 'claude prompt',
      schema: FINDINGS,
      root: tmp,
      runDir,
      cwd,
      model: 'claude-3-7-sonnet',
    };

    const res = await runSeatCall(call, {
      backend: { name: 'claude', exe: '/mock/bin/claude' },
      runChild: fakeRunChild,
    });

    assert.equal(res.ok, true);
    assert.deepEqual(res.value, { findings: [] });
    assert.equal(capturedCall.cmd, '/mock/bin/claude');
    assert.equal(capturedCall.cwd, cwd);
    assert.equal(capturedCall.args.includes('--restricted'), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
