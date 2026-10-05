import { realpathSync } from 'node:fs';
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
import { beginClosing, resetClosingForTests } from '../skills/adversarial-review/scripts/lib/proc.mjs';

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
    assert.equal(typeof mod.streaming, 'function');
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
    'stream-json',
    '--verbose',
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
    'stream-json',
    '--verbose',
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

// Through the background service, one full set of the user's MCP servers starts for every new
// lane directory and outlives the lane. `--standalone` plus the isolated XDG home is what keeps
// a zen lane to two processes that a tree kill removes.
test('opencode zen lane: standalone, isolated XDG home, profile cwd, no agent, no config env, prompt only on stdin', () => {
  const call = {
    callId: 'c1',
    prompt: 'SEAT PROMPT',
    model: 'opencode/big-pickle',
    lane: {
      mode: 'zen',
      cwd: '/run/sandbox/profiles/weak-find',
      xdgHome: '/run/sandbox/xdg/weak-find/zen',
      stage: 'FIND',
    },
  };
  const built = opencodeBackend.build(call, {
    platform: 'linux',
    env: { PATH: '/bin', MY_API_KEY: 'k', GH_TOKEN: 't', HOME: '/h', XDG_CONFIG_HOME: '/h/.config' },
  });
  assert.deepEqual(built.args, ['run', '--standalone', '--format', 'json', '--auto', '-m', 'opencode/big-pickle']);
  assert.ok(!built.args.includes('--agent'));
  assert.equal(built.cwd, '/run/sandbox/profiles/weak-find');
  assert.equal(built.env.XDG_CONFIG_HOME, '/run/sandbox/xdg/weak-find/zen');
  assert.equal(built.env.PWD, '/run/sandbox/profiles/weak-find');
  assert.equal(built.env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(built.env.MY_API_KEY, undefined);
  assert.equal(built.env.GH_TOKEN, undefined);
  assert.equal(built.env.PATH, '/bin');
  assert.equal(built.env.HOME, '/h');
  assert.equal(built.stdin, 'SEAT PROMPT');
  assert.deepEqual(built.files, {});
});

test('opencode named lane: standalone, ar-seat agent, isolated XDG home', () => {
  const built = opencodeBackend.build(
    {
      prompt: 'P',
      model: 'acme/example-model',
      lane: { mode: 'named', cwd: '/c', xdgHome: '/run/sandbox/xdg/short/acme', stage: 'TABLE' },
    },
    { env: { PATH: '/bin' } }
  );
  assert.deepEqual(built.args, [
    'run',
    '--standalone',
    '--format',
    'json',
    '--auto',
    '--agent',
    'ar-seat',
    '-m',
    'acme/example-model',
  ]);
  assert.equal(built.env.XDG_CONFIG_HOME, '/run/sandbox/xdg/short/acme');
  assert.equal(built.cwd, '/c');
});

// Spec A8 sets no effort variant for opencode, so `#high` never reaches the model id.
test('opencode build: no effort variant, and a call without a lane falls back to the zen command', () => {
  const built = opencodeBackend.build(
    { prompt: 'P', model: 'opencode/big-pickle', effort: 'high', cwd: '/fallback' },
    { env: { PATH: '/bin' } }
  );
  assert.deepEqual(built.args, ['run', '--standalone', '--format', 'json', '--auto', '-m', 'opencode/big-pickle']);
  assert.equal(built.cwd, '/fallback');
  assert.equal(built.env.XDG_CONFIG_HOME, undefined);
});

// A zen lane with no isolated home keeps the parent value: an `XDG_CONFIG_HOME` of `undefined`
// would reach the child as the text "undefined" and point at nothing.
test('opencode build: a zen lane without an isolated home keeps the parent XDG_CONFIG_HOME', () => {
  const built = opencodeBackend.build(
    { prompt: 'P', model: 'opencode/big-pickle', lane: { mode: 'zen', cwd: '/c', stage: 'FIND' } },
    { env: { PATH: '/bin', XDG_CONFIG_HOME: '/h/.config' } }
  );
  assert.equal(built.env.XDG_CONFIG_HOME, '/h/.config');
});

// `opencode run` resolves the session directory as `root ?? process.env.PWD ?? process.cwd()`,
// so an inherited PWD wins over the cwd of the lane process. A lane that keeps the engine's PWD
// loads the engine's project config, not the profile, and every A7 permission rule is inert.
test('opencode build: the lane PWD is the lane cwd, in both modes', () => {
  const parent = { PATH: '/bin', PWD: '/engine/repo', OLDPWD: '/engine' };

  const zen = opencodeBackend.build(
    { prompt: 'P', model: 'opencode/big-pickle', lane: { mode: 'zen', cwd: '/run/sandbox/profiles/weak-find', stage: 'FIND' } },
    { env: parent }
  );
  assert.equal(zen.env.PWD, '/run/sandbox/profiles/weak-find');
  assert.equal(zen.env.OLDPWD, undefined);

  const named = opencodeBackend.build(
    {
      prompt: 'P',
      model: 'acme/example-model',
      lane: { mode: 'named', cwd: '/run/sandbox/profiles/short', xdgHome: '/run/sandbox/xdg/short/acme', stage: 'TABLE' },
    },
    { env: parent }
  );
  assert.equal(named.env.PWD, '/run/sandbox/profiles/short');
  assert.equal(named.env.OLDPWD, undefined);

  // A call with no lane falls back to `call.cwd`, so that path needs the same agreement.
  const fallback = opencodeBackend.build({ prompt: 'P', model: 'opencode/big-pickle', cwd: '/fallback' }, { env: parent });
  assert.equal(fallback.env.PWD, '/fallback');
});

test('scrubEnv drops every secret-shaped name and keeps the rest', () => {
  const out = opencodeBackend.scrubEnv({
    PATH: '/bin',
    OPENAI_API_KEY: 'a',
    gh_token: 'b',
    MY_SECRET: 'c',
    DB_PASSWORD: 'd',
    AWS_CREDENTIAL_FILE: 'e',
    KEYBOARD: 'f',
  });
  assert.deepEqual(Object.keys(out).sort(), ['PATH']);
});

test('lane tool lists match part D validation and the swarm list has no git commands', async () => {
  const { SWARM_LANE_TOOLS, HOST_LANE_TOOLS, laneToolsFor } = await import(
    '../skills/adversarial-review/scripts/lib/lane.mjs'
  );
  const re = /^[A-Za-z][A-Za-z0-9 _.-]{0,40}$/;
  for (const t of [...SWARM_LANE_TOOLS, ...HOST_LANE_TOOLS.claude]) assert.match(t, re);
  assert.deepEqual(SWARM_LANE_TOOLS, ['read', 'glob', 'grep']);
  assert.deepEqual(laneToolsFor({ finderRoutesToSwarm: true, hostBackend: 'claude' }), ['read', 'glob', 'grep']);
  assert.deepEqual(laneToolsFor({ finderRoutesToSwarm: false, hostBackend: 'claude' }), ['Read', 'Grep', 'Glob']);
  for (const b of ['codex', 'gemini', 'custom']) {
    assert.deepEqual(laneToolsFor({ finderRoutesToSwarm: false, hostBackend: b }), ['Read', 'Grep', 'Glob']);
  }
  assert.deepEqual(laneToolsFor({ finderRoutesToSwarm: false, hostBackend: 'opencode' }), ['read', 'glob', 'grep']);
  // The caller gets a copy: the exported lists stay frozen.
  const copy = laneToolsFor({ finderRoutesToSwarm: true, hostBackend: 'claude' });
  copy.push('shell');
  assert.deepEqual(SWARM_LANE_TOOLS, ['read', 'glob', 'grep']);
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

test('claude backend: stream-json argv keeps --json-schema', () => {
  const { args } = claudeBackend.build(
    { root: '/r', runDir: '/d', schema: { type: 'object' } },
    {}
  );
  const i = args.indexOf('--output-format');
  assert.equal(args[i + 1], 'stream-json');
  assert.ok(args.includes('--verbose'));
  assert.ok(args.includes('--json-schema'));
  assert.ok(args.includes('--strict-mcp-config'));
});

test('claude extract: last result line wins, structured_output first', () => {
  const stdout = [
    '{"type":"system","subtype":"init"}',
    'not json',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"draft"}]}}',
    '{"type":"result","subtype":"success","result":"{\\"ok\\":false}","structured_output":{"ok":true}}',
  ].join('\n');
  assert.equal(claudeBackend.extract({ stdout }), '{"ok":true}');
});

test('claude extract: no result line falls back to the last assistant text', () => {
  const stdout =
    '{"type":"assistant","message":{"content":[{"type":"text","text":"```json\\n{\\"findings\\":[]}\\n```"}]}}\n';
  // Raw stdout also matches /findings/, but it carries the text JSON-escaped, which the fence
  // parser cannot read. Assert the decoded text, so a fall-through to stdout fails here.
  assert.equal(claudeBackend.extract({ stdout }), '```json\n{"findings":[]}\n```');
});

test('claude extract: empty result and null structured_output fall back to assistant text', () => {
  const text = '```json\n{"findings":[]}\n```';
  const stdout = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
    JSON.stringify({ type: 'result', result: '', structured_output: null }),
  ].join('\n');
  assert.equal(claudeBackend.extract({ stdout }), text);
});

test('claude extract: a stream with no assistant text and no usable result falls back to stdout', () => {
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'result', result: '', structured_output: undefined }),
  ].join('\n');
  assert.equal(claudeBackend.extract({ stdout }), stdout);
});

test('streaming(): only stream modes are streaming', () => {
  assert.equal(claudeBackend.streaming({}), true);
  assert.equal(codexBackend.streaming({}), false);
  assert.equal(customBackend.streaming({}), false);
  assert.equal(geminiBackend.streaming({}), false);
  // opencode `build` emits `--format json` in both lane modes (Part A).
  assert.equal(opencodeBackend.streaming({}), true);
});

test('codex build: uses call.outFile when given', () => {
  const built = codexBackend.build(
    {
      callId: 'c',
      runDir: '/d',
      root: '/r',
      cwd: '/r',
      outFile: '/d/calls/c.a2.out.json',
      schema: {},
    },
    {}
  );
  assert.equal(built.outFile, '/d/calls/c.a2.out.json');
  assert.ok(built.args.includes('/d/calls/c.a2.out.json'));
});

test('custom build: uses call.outFile when given', () => {
  const config = { backends: { custom: { command: ['my-cli', '--out', '{outFile}'] } } };
  const built = customBackend.build(
    { callId: 'c', runDir: '/d', root: '/r', cwd: '/r', outFile: '/d/calls/c.a3.out.json' },
    { config }
  );
  assert.equal(built.outFile, '/d/calls/c.a3.out.json');
  assert.deepEqual(built.args, ['my-cli', '--out', '/d/calls/c.a3.out.json']);
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
    assert.equal(existsSync(path.join(runDir, 'calls', 'bad-call.r1.a1.log')), false);
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

    const logFile = path.join(runDir, 'calls', 'c1.r1.a1.log');
    assert.equal(existsSync(logFile), true);

    const logContent = await readFile(logFile, 'utf8');
    assert.match(logContent, /argv/i);
    assert.match(logContent, /echo-seat\.mjs/);
    assert.equal(logContent.includes('echo prompt'), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: fake seat prints prose -> ok:false, error starts with parse, attempts === 3, three logs', async () => {
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
    assert.equal(res.attempts, 3);

    assert.equal(existsSync(path.join(runDir, 'calls', 'c-prose.r1.a1.log')), true);
    assert.equal(existsSync(path.join(runDir, 'calls', 'c-prose.r1.a2.log')), true);
    assert.equal(existsSync(path.join(runDir, 'calls', 'c-prose.r1.a3.log')), true);
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

    assert.equal(existsSync(path.join(runDir, 'calls', 'c-retry.r1.a1.log')), true);
    assert.equal(existsSync(path.join(runDir, 'calls', 'c-retry.r1.a2.log')), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: timeoutMs: 200 seat sleeps -> ok:false, error: timeout, attempts: 2', async () => {
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
    // One model and a hard timeout: the same model gets one retry, not the whole attempt budget.
    assert.equal(res.attempts, 2);
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
    assert.equal(existsSync(path.join(runDir, 'calls', 'c-base.r1.a3.log')), true);
    assert.equal(existsSync(path.join(runDir, 'calls', 'c-base.r1.a1.log')), false);
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
    assert.equal(realpathSync(recorded), realpathSync(cwd));
    assert.equal(realpathSync(res.value.cwd), realpathSync(cwd));
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

    // A final log of an older process, with no live log beside it: attempt 1 is taken.
    await writeFile(path.join(callsDir, 'c1.r1.a1.log'), 'PRE-EXISTING CONTENT', 'utf8');

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
    const oldLog = await readFile(path.join(callsDir, 'c1.r1.a1.log'), 'utf8');
    assert.equal(oldLog, 'PRE-EXISTING CONTENT');

    // New log was written to a2.log
    assert.equal(existsSync(path.join(callsDir, 'c1.r1.a2.log')), true);
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
    const promptPath = path.join(runDir, 'calls', 'c-sync-prompt.r1.a2.prompt.txt');
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

// --- runSeatCall x the opencode event stream (task A1 wiring) --------------

// One NDJSON line, as the opencode v2 stream writes it.
const ndjson = (obj) => `${JSON.stringify(obj)}\n`;

// Mirrors runChild for a streaming lane: every chunk reaches onStdout BEFORE
// the promise resolves, which is the order the real child gives. Each element
// of plans is one attempt; the last plan repeats if more attempts happen.
function streamingRunChild(plans) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    const plan = plans[Math.min(calls.length - 1, plans.length - 1)];
    const chunks = plan.chunks || [];
    for (const chunk of chunks) {
      if (typeof opts.onStdout === 'function') opts.onStdout(Buffer.from(chunk, 'utf8'));
    }
    return {
      code: plan.code ?? 0,
      signal: null,
      stdout: chunks.join(''),
      stderr: '',
      timedOut: plan.timedOut ?? false,
      spawnError: plan.spawnError ?? null,
    };
  };
  fn.calls = calls;
  return fn;
}

async function opencodeCall(tmp, callId, extra = {}) {
  const runDir = path.join(tmp, 'run');
  const cwd = path.join(runDir, 'cwd');
  await mkdir(cwd, { recursive: true });
  return {
    callId,
    prompt: 'seat prompt',
    schema: FINDINGS,
    root: tmp,
    runDir,
    cwd,
    model: 'gemini-3.8-flash',
    ...extra,
  };
}

const OPENCODE_BACKEND = { name: 'opencode', exe: '/mock/bin/opencode' };

test('runSeatCall: the opencode stream yields the answer, the cost and the step count, and the parser is flushed when the last line has no newline', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const call = await opencodeCall(tmp, 'c-stream');
    // No trailing newline on the answer: only parser.end() can flush it.
    const answer = ndjson({
      type: 'text',
      messageID: 'm1',
      part: { type: 'text', text: '```json\n{"findings":[]}\n```' },
    }).trimEnd();
    const finish = ndjson({
      type: 'step_finish',
      messageID: 'm1',
      part: { cost: 0.0012, tokens: { input: 100, output: 20, reasoning: 5 } },
    });
    const runChildFake = streamingRunChild([
      {
        chunks: [
          ndjson({ type: 'step_start', messageID: 'm1' }) + finish.slice(0, 12),
          finish.slice(12),
          answer,
        ],
      },
    ]);

    const res = await runSeatCall(call, { backend: OPENCODE_BACKEND, runChild: runChildFake });

    assert.equal(res.ok, true);
    assert.deepEqual(res.value, { findings: [] });
    assert.equal(res.attempts, 1);
    assert.equal(res.costTotal, 0.0012);
    assert.equal(res.tokensTotal, 125);
    assert.equal(res.costComplete, true);
    assert.equal(res.stepCount, 1);
    assert.equal(res.toolRefusals, 0);
    assert.equal(res.errorType, null);
    assert.equal(res.model, 'gemini-3.8-flash');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: call.onEvent receives every parsed event, and a listener that throws does not break the call', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const stream = [
      ndjson({ type: 'step_start', messageID: 'm1' }),
      ndjson({
        type: 'tool_use',
        messageID: 'm1',
        part: { tool: 'write', state: { status: 'error', error: 'Permission denied: edit' } },
      }),
      ndjson({
        type: 'text',
        messageID: 'm1',
        part: { type: 'text', text: '```json\n{"findings":[]}\n```' },
      }),
    ];

    const seen = [];
    const okCall = await opencodeCall(tmp, 'c-events', { onEvent: (e) => seen.push(e) });
    const res = await runSeatCall(okCall, {
      backend: OPENCODE_BACKEND,
      runChild: streamingRunChild([{ chunks: stream }]),
    });

    assert.equal(res.ok, true);
    assert.deepEqual(
      seen.map((e) => e.type),
      ['step_start', 'tool_use', 'text']
    );
    assert.deepEqual(
      seen,
      stream.map((line) => JSON.parse(line))
    );
    assert.equal(res.toolRefusals, 1);

    const throwingCall = await opencodeCall(tmp, 'c-events-throw', {
      onEvent: () => {
        throw new Error('listener blew up');
      },
    });
    const res2 = await runSeatCall(throwingCall, {
      backend: OPENCODE_BACKEND,
      runChild: streamingRunChild([{ chunks: stream }]),
    });
    assert.equal(res2.ok, true);
    assert.deepEqual(res2.value, { findings: [] });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: a provider refusal and a missing model do not take a second attempt', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const refused = streamingRunChild([
      { chunks: [ndjson({ type: 'error', error: { status: 403, message: 'switched off' } })] },
    ]);
    const res = await runSeatCall(await opencodeCall(tmp, 'c-403'), {
      backend: OPENCODE_BACKEND,
      runChild: refused,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'provider-refused');
    assert.equal(res.errorType, 'provider-refused');
    assert.equal(res.attempts, 1);
    assert.equal(refused.calls.length, 1);
    assert.equal(res.model, 'gemini-3.8-flash');

    const missing = streamingRunChild([
      { chunks: [ndjson({ type: 'error', error: { status: 404, message: 'no such model' } })] },
    ]);
    const res2 = await runSeatCall(await opencodeCall(tmp, 'c-404'), {
      backend: OPENCODE_BACKEND,
      runChild: missing,
    });
    assert.equal(res2.error, 'not-found');
    assert.equal(res2.errorType, 'not-found');
    assert.equal(res2.attempts, 1);
    assert.equal(missing.calls.length, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: an answer with no text retries once, and attempt 2 parses into a clean event list', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runChildFake = streamingRunChild([
      {
        // Three steps and no text part: extract reports bad-output.
        chunks: [
          ndjson({ type: 'step_start', messageID: 'm1' }),
          ndjson({ type: 'step_start', messageID: 'm1' }),
          ndjson({ type: 'step_start', messageID: 'm1' }),
          ndjson({ type: 'tool_use', messageID: 'm1', part: { tool: 'read' } }),
        ],
      },
      {
        chunks: [
          ndjson({ type: 'step_start', messageID: 'm2' }),
          ndjson({
            type: 'text',
            messageID: 'm2',
            part: { type: 'text', text: '```json\n{"findings":[]}\n```' },
          }),
        ],
      },
    ]);

    const res = await runSeatCall(await opencodeCall(tmp, 'c-badoutput'), {
      backend: OPENCODE_BACKEND,
      runChild: runChildFake,
    });

    assert.equal(res.ok, true);
    assert.equal(res.attempts, 2);
    assert.equal(runChildFake.calls.length, 2);
    // One step, not four: attempt 2 gets its own parser and its own event list.
    assert.equal(res.stepCount, 1);
    assert.match(
      runChildFake.calls[1].stdin,
      /^seat prompt\n\nYour previous answer failed: bad-output: step cap reached\. Answer again with ONE fenced json block\.$/
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: a timeout and a spawn failure keep the event fields and name their own errorType', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const stepFinish = ndjson({
      type: 'step_finish',
      messageID: 'm1',
      part: { cost: 0.5, tokens: { input: 4, output: 6 } },
    });

    const timedOut = await runSeatCall(await opencodeCall(tmp, 'c-stream-timeout'), {
      backend: OPENCODE_BACKEND,
      runChild: streamingRunChild([{ chunks: [stepFinish], timedOut: true }]),
    });
    assert.equal(timedOut.error, 'timeout');
    assert.equal(timedOut.errorType, 'timeout');
    // A hard timeout gives the same model one retry, not the whole attempt budget.
    assert.equal(timedOut.attempts, 2);
    assert.equal(timedOut.costTotal, 0.5);
    assert.equal(timedOut.tokensTotal, 10);
    assert.equal(timedOut.model, 'gemini-3.8-flash');

    const spawned = await runSeatCall(await opencodeCall(tmp, 'c-stream-spawn'), {
      backend: OPENCODE_BACKEND,
      runChild: streamingRunChild([{ chunks: [], spawnError: new Error('ENOENT') }]),
    });
    assert.equal(spawned.error, 'spawn');
    assert.equal(spawned.errorType, 'spawn');
    assert.equal(spawned.costTotal, 0);
    assert.equal(spawned.costComplete, false);
    assert.equal(spawned.stepCount, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: an unparsable answer fails after three attempts with the event fields and no errorType', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runChildFake = streamingRunChild([
      {
        chunks: [
          ndjson({
            type: 'step_finish',
            messageID: 'm1',
            part: { cost: 0.25, tokens: { input: 3 } },
          }),
          ndjson({ type: 'text', messageID: 'm1', part: { type: 'text', text: 'prose, no json' } }),
        ],
      },
    ]);

    const res = await runSeatCall(await opencodeCall(tmp, 'c-stream-parse'), {
      backend: OPENCODE_BACKEND,
      runChild: runChildFake,
    });

    assert.equal(res.ok, false);
    assert.match(res.error, /^parse/);
    assert.equal(res.attempts, 3);
    assert.equal(runChildFake.calls.length, 3);
    assert.equal(res.errorType, null);
    assert.equal(res.costTotal, 0.25);
    assert.equal(res.costComplete, true);
    assert.equal(res.tokensTotal, 3);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: a backend with no event parser reports the default event fields', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });

    let sawOnStdout;
    const res = await runSeatCall(
      {
        callId: 'c-no-parser',
        prompt: 'claude prompt',
        schema: FINDINGS,
        root: tmp,
        runDir,
        cwd,
        model: 'claude-3-7-sonnet',
      },
      {
        backend: { name: 'claude', exe: '/mock/bin/claude' },
        runChild: async (opts) => {
          sawOnStdout = opts.onStdout;
          return {
            code: 0,
            signal: null,
            stdout: JSON.stringify({ structured_output: { findings: [] } }),
            stderr: '',
            timedOut: false,
            spawnError: null,
          };
        },
      }
    );

    assert.equal(res.ok, true);
    // Every attempt writes a live log, so onStdout is attached whatever the adapter parses.
    assert.equal(typeof sawOnStdout, 'function');
    assert.equal(res.costTotal, null);
    assert.equal(res.tokensTotal, null);
    assert.equal(res.costComplete, false);
    assert.equal(res.toolRefusals, 0);
    assert.equal(res.stepCount, 0);
    assert.equal(res.errorType, null);
    assert.equal(res.model, 'claude-3-7-sonnet');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: a non-zero exit on every attempt keeps the event fields', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runChildFake = streamingRunChild([
      {
        code: 1,
        chunks: [
          ndjson({
            type: 'step_finish',
            messageID: 'm1',
            part: { cost: 0.75, tokens: { input: 8, output: 2 } },
          }),
        ],
      },
    ]);

    const res = await runSeatCall(await opencodeCall(tmp, 'c-stream-exit'), {
      backend: OPENCODE_BACKEND,
      runChild: runChildFake,
    });

    assert.equal(res.ok, false);
    assert.equal(res.error, 'exit-1');
    assert.equal(res.attempts, 3);
    assert.equal(runChildFake.calls.length, 3);
    assert.equal(res.costTotal, 0.75);
    assert.equal(res.costComplete, true);
    assert.equal(res.tokensTotal, 10);
    assert.equal(res.stepCount, 0);
    assert.equal(res.errorType, null);
    assert.equal(res.model, 'gemini-3.8-flash');
    // A non-zero exit is not a contract failure, so the prompt of attempt 2 is unchanged.
    assert.equal(runChildFake.calls[1].stdin, 'seat prompt');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// The scrub only matters at the spawn boundary: a unit test of build() cannot see a later merge
// in runSeatCall undo it. This test reads the env object that reaches runChild.
test('runSeatCall: an opencode lane spawns with the scrubbed env, and the lane cwd, not the call cwd', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const profileCwd = path.join(tmp, 'profiles', 'weak-find');
    await mkdir(profileCwd, { recursive: true });

    const call = await opencodeCall(tmp, 'c-env-scrub', {
      lane: { mode: 'zen', cwd: profileCwd, stage: 'FIND' },
    });
    const runChildFake = streamingRunChild([
      {
        chunks: [
          ndjson({
            type: 'text',
            messageID: 'm1',
            part: { type: 'text', text: '```json\n{"findings":[]}\n```' },
          }),
        ],
      },
    ]);

    const res = await runSeatCall(call, {
      // A secret-shaped name on the backend object must not reach the lane either.
      backend: { ...OPENCODE_BACKEND, env: { EXTRA_TOKEN: 'leak-me' } },
      env: {
        PATH: '/bin',
        HOME: '/h',
        MY_API_KEY: 'sk-live-must-not-leak',
        GH_TOKEN: 'ghp-must-not-leak',
        AWS_SECRET_ACCESS_KEY: 'must-not-leak',
        DB_PASSWORD: 'must-not-leak',
        GCP_CREDENTIAL_FILE: 'must-not-leak',
        OPENCODE_SAFE: '1',
      },
      runChild: runChildFake,
    });

    assert.equal(res.ok, true);
    const spawned = runChildFake.calls[0].env;
    // Not trivially empty: the lane still needs PATH and the non-secret variables.
    assert.equal(spawned.PATH, '/bin');
    assert.equal(spawned.HOME, '/h');
    assert.equal(spawned.OPENCODE_SAFE, '1');
    assert.equal(spawned.MY_API_KEY, undefined);
    assert.equal(spawned.GH_TOKEN, undefined);
    assert.equal(spawned.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(spawned.DB_PASSWORD, undefined);
    assert.equal(spawned.GCP_CREDENTIAL_FILE, undefined);
    assert.equal(spawned.EXTRA_TOKEN, undefined);
    const leaked = Object.keys(spawned).filter((k) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k));
    assert.deepEqual(leaked, []);
    // built.cwd carries the sandbox profile, which is the read-only boundary of the lane.
    assert.equal(runChildFake.calls[0].cwd, profileCwd);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// The real swarm run resolves the executable through resolveBackend (cli/run.mjs), so both arms
// of the opencode branch are exercised here, not only resolveOpencodeExe on its own.
test('resolveBackend: opencode uses its own lookup and lists every searched path when it finds nothing', async () => {
  // A configured path that does NOT exist: the generic PATHEXT resolution would reject it, so a
  // success here can only come from the opencode branch.
  const absent = path.join(tmpdir(), 'ar-absent-opencode', 'opencode.exe');
  const resolved = await resolveBackend('opencode', {
    config: { backends: { opencode: { exe: absent } } },
    env: {},
  });
  assert.equal(resolved.name, 'opencode');
  assert.equal(resolved.exe, absent);

  await assert.rejects(
    () => resolveBackend('opencode', { config: {}, env: {} }),
    (err) =>
      err instanceof ConfigError &&
      err.message.startsWith('opencode executable not found. Searched: ') &&
      err.message.includes('PATH:opencode')
  );
});

// --- runSeatCall x the model list, the live log and the attempt rules (task C4) -------------

// The fixture reads the model name from the last argv item, so one command covers every behavior.
function modelBackend() {
  return {
    name: 'custom',
    exe: process.execPath,
    command: [process.execPath, path.resolve('test/fixtures/backends/model-seat.mjs'), '{model}'],
    streaming: () => true,
  };
}

test('runSeatCall: idle on model 1 fails over to model 2', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });
    const seen = { attempts: [], stalled: [], failover: [], stdout: [] };
    const res = await runSeatCall(
      {
        callId: 'f1',
        prompt: 'p',
        schema: FINDINGS,
        root: tmp,
        runDir,
        cwd,
        models: ['silent', 'okmodel'],
        idleMs: 300,
        timeoutMs: 10000,
      },
      {
        backend: modelBackend(),
        onAttempt: (a) => seen.attempts.push(a),
        onStalled: (s) => seen.stalled.push(s),
        onFailover: (f) => seen.failover.push(f),
        onStdout: (s) => seen.stdout.push(s),
      }
    );
    assert.equal(res.ok, true);
    assert.equal(res.model, 'okmodel');
    assert.equal(res.attempts, 2);
    assert.deepEqual(seen.failover, [{ from: 'silent', to: 'okmodel', reason: 'idle' }]);
    assert.equal(seen.stalled[0].action, 'failover');
    assert.deepEqual(seen.attempts, [
      { attempt: 1, model: 'silent' },
      { attempt: 2, model: 'okmodel' },
    ]);
    assert.ok(seen.stdout.length > 0);
    assert.ok(existsSync(path.join(runDir, 'calls', 'f1.r1.a1.live.log')));
    assert.match(await readFile(path.join(runDir, 'calls', 'f1.r1.a1.live.log'), 'utf8'), /start/);
    assert.ok(existsSync(path.join(runDir, 'calls', 'f1.r1.a2.log')));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// The exit sweep has begun: a failover would start the next lane after the sweep copied its
// pids, and that lane would outlive the run (3.1 review C4).
async function closingCall(runChild) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });
    const failover = [];
    const res = await runSeatCall(
      { callId: 'ab', prompt: 'p', schema: FINDINGS, root: tmp, runDir, cwd, models: ['m1', 'm2'] },
      { backend: { name: 'claude', exe: '/mock/bin/claude' }, runChild, onFailover: (f) => failover.push(f) }
    );
    return { res, failover };
  } finally {
    resetClosingForTests();
    await rm(tmp, { recursive: true, force: true });
  }
}

test('runSeatCall: closing already begun -> zero spawns, no failover, error aborted', async () => {
  let spawns = 0;
  beginClosing();
  const { res, failover } = await closingCall(async () => { spawns++; return { code: 1, stdout: '', stderr: '' }; });
  assert.equal(spawns, 0);
  assert.deepEqual(failover, []);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'aborted');
});

test('runSeatCall: closing begins during the call and the child reports aborted -> one spawn, no failover', async () => {
  let spawns = 0;
  const { res, failover } = await closingCall(async () => {
    spawns++;
    beginClosing();
    return { aborted: true, code: null, signal: null, stdout: '', stderr: '', timedOut: false, idled: false, spawnError: null };
  });
  assert.equal(spawns, 1);
  assert.deepEqual(failover, []);
  assert.equal(res.error, 'aborted');
});

// A lane the sweep killed comes back with an exit code, not with `aborted`.
test('runSeatCall: closing begins during the call and the sweep kills the lane -> one spawn, no failover', async () => {
  let spawns = 0;
  const { res, failover } = await closingCall(async () => {
    spawns++;
    beginClosing();
    return { code: 1, signal: null, stdout: '', stderr: '', timedOut: false, idled: false, spawnError: null };
  });
  assert.equal(spawns, 1);
  assert.deepEqual(failover, []);
  assert.equal(res.error, 'aborted');
});

test('runSeatCall: contract failure moves to the next model when one exists', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });
    const failover = [];
    const res = await runSeatCall(
      { callId: 'f2', prompt: 'p', schema: FINDINGS, root: tmp, runDir, cwd, models: ['prose', 'okmodel'] },
      { backend: modelBackend(), onFailover: (f) => failover.push(f) }
    );
    assert.equal(res.ok, true);
    assert.deepEqual(failover, [{ from: 'prose', to: 'okmodel', reason: 'contract' }]);
    // A list of more than one model never resends the prompt with the "answer again" suffix.
    assert.equal(existsSync(path.join(runDir, 'calls', 'f2.r1.a2.prompt.txt')), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: one model and a contract failure retries the same model, cap 3 attempts', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });
    const res = await runSeatCall(
      { callId: 'f3', prompt: 'p', schema: FINDINGS, root: tmp, runDir, cwd, models: ['prose'] },
      { backend: modelBackend() }
    );
    assert.equal(res.ok, false);
    assert.equal(res.attempts, 3);
    assert.match(await readFile(path.join(runDir, 'calls', 'f3.r1.a3.prompt.txt'), 'utf8'), /Answer again/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: a non-streaming adapter gets no idle deadline', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });
    const backend = { ...modelBackend(), streaming: () => false };
    const res = await runSeatCall(
      {
        callId: 'f4',
        prompt: 'p',
        schema: FINDINGS,
        root: tmp,
        runDir,
        cwd,
        models: ['silent'],
        idleMs: 200,
        timeoutMs: 1500,
      },
      { backend }
    );
    assert.equal(res.error, 'timeout');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: attempt n is reserved by the live log before the child starts', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(path.join(runDir, 'calls'), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(runDir, 'calls', 'f5.r1.a1.live.log'), 'taken');
    const res = await runSeatCall(
      { callId: 'f5', prompt: 'p', schema: FINDINGS, root: tmp, runDir, cwd, models: ['okmodel'] },
      { backend: modelBackend() }
    );
    assert.equal(res.ok, true);
    assert.ok(existsSync(path.join(runDir, 'calls', 'f5.r1.a2.log')));
    assert.equal(await readFile(path.join(runDir, 'calls', 'f5.r1.a1.live.log'), 'utf8'), 'taken');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: a round of 2 writes its own prompt and schema and leaves round 1 alone', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });
    const base = { callId: 'f6', schema: FINDINGS, root: tmp, runDir, cwd, models: ['okmodel'] };
    await runSeatCall({ ...base, prompt: 'first round' }, { backend: modelBackend() });
    await runSeatCall({ ...base, prompt: 'second round', round: 2 }, { backend: modelBackend() });

    const calls = path.join(runDir, 'calls');
    assert.equal(await readFile(path.join(calls, 'f6.r1.prompt.txt'), 'utf8'), 'first round');
    assert.equal(await readFile(path.join(calls, 'f6.r2.prompt.txt'), 'utf8'), 'second round');
    assert.ok(existsSync(path.join(calls, 'f6.r2.schema.json')));
    assert.ok(existsSync(path.join(calls, 'f6.r2.a1.log')));
    assert.equal(existsSync(path.join(calls, 'f6.prompt.txt')), false);

    await assert.rejects(
      () => runSeatCall({ ...base, prompt: 'p', round: 0 }, { backend: modelBackend() }),
      (err) => err instanceof ConfigError && /round/.test(err.message)
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: every model of the list is validated before the first spawn', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });
    const res = await runSeatCall(
      { callId: 'f7', prompt: 'p', schema: FINDINGS, root: tmp, runDir, cwd, models: ['okmodel', '--x'] },
      { backend: modelBackend() }
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, 'bad-model');
    assert.equal(res.attempts, 0);
    assert.equal(existsSync(path.join(runDir, 'calls', 'f7.r1.a1.live.log')), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: a custom command reads the prompt and schema files of the round', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });
    const seenArgs = [];
    const res = await runSeatCall(
      { callId: 'f8', prompt: 'p', schema: FINDINGS, root: tmp, runDir, cwd, models: ['prose', 'okmodel'] },
      {
        backend: {
          name: 'custom',
          exe: process.execPath,
          command: [
            process.execPath,
            path.resolve('test/fixtures/backends/model-seat.mjs'),
            '--prompt',
            '{promptFile}',
            '--schema',
            '{schemaFile}',
            '{model}',
          ],
        },
        runChild: async (opts) => {
          seenArgs.push(opts.args);
          return {
            code: 0,
            signal: null,
            stdout: seenArgs.length === 1 ? 'prose' : '```json\n{"findings":[]}\n```',
            stderr: '',
            timedOut: false,
            idled: false,
            spawnError: null,
          };
        },
      }
    );
    assert.equal(res.ok, true);
    const calls = path.join(runDir, 'calls');
    assert.ok(seenArgs[0].includes(path.join(calls, 'f8.r1.prompt.txt')));
    assert.ok(seenArgs[0].includes(path.join(calls, 'f8.r1.schema.json')));
    assert.ok(existsSync(path.join(calls, 'f8.r1.schema.json')));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// A hard timeout costs the whole stage timeout per attempt, so one model gets at most one retry.
function timeoutRunChild() {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    return { code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true, idled: false, spawnError: null };
  };
  fn.calls = calls;
  return fn;
}

test('runSeatCall: a hard timeout on a one-model list retries that model once, then stops', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });
    const runChild = timeoutRunChild();
    const res = await runSeatCall(
      { callId: 't1', prompt: 'p', schema: FINDINGS, root: tmp, runDir, cwd, models: ['okmodel'], timeoutMs: 1000 },
      { backend: modelBackend(), runChild }
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, 'timeout');
    assert.equal(res.attempts, 2);
    assert.equal(runChild.calls.length, 2);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runSeatCall: a hard timeout moves to the next model at once; the last model gets one retry', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-test-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });
    const seen = { attempts: [], failover: [] };
    const res = await runSeatCall(
      { callId: 't2', prompt: 'p', schema: FINDINGS, root: tmp, runDir, cwd, models: ['first', 'second'], timeoutMs: 1000 },
      {
        backend: modelBackend(),
        runChild: timeoutRunChild(),
        onAttempt: (a) => seen.attempts.push(a.model),
        onFailover: (f) => seen.failover.push(f),
      }
    );
    assert.equal(res.error, 'timeout');
    assert.deepEqual(seen.attempts, ['first', 'second', 'second']);
    assert.deepEqual(seen.failover, [{ from: 'first', to: 'second', reason: 'timeout' }]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
