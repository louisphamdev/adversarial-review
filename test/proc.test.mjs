import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod, access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  getEnvCaseInsensitive,
  resolveExecutable,
  system32Path,
  expandArgs,
  ALLOWED_PLACEHOLDERS,
  resolveNpmShim,
  spawnResolved,
  runChild,
  forceKill,
  trackedChildren,
  killAllTrackedSync,
  installSignalHandlers,
  runWithTimeout,
  runWithWatchdog,
  sanePositiveSec,
  createMarkerScanner,
  collectStream,
  collectOutput,
  collectStderr,
  waitForExit,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_INACTIVITY_SEC,
  DEFAULT_HARDCAP_SEC,
  MAX_OUTPUT_BYTES,
  FORCE_KILL_GRACE_MS,
  TIMEOUT_SENTINEL,
  MAX_SANE_SEC,
} from '../skills/adversarial-review/scripts/lib/proc.mjs';

function spawnNode(src, options = {}) {
  return spawn(process.execPath, ['-e', src], {
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...options,
  });
}

describe('proc module exports', () => {
  it('exports expected functions and constants', () => {
    assert.equal(typeof getEnvCaseInsensitive, 'function');
    assert.equal(typeof resolveExecutable, 'function');
    assert.equal(typeof system32Path, 'function');
    assert.equal(typeof expandArgs, 'function');
    assert.equal(typeof resolveNpmShim, 'function');
    assert.equal(typeof spawnResolved, 'function');
    assert.equal(typeof runChild, 'function');
    assert.equal(typeof forceKill, 'function');
    assert.equal(typeof killAllTrackedSync, 'function');
    assert.equal(typeof installSignalHandlers, 'function');
    assert.ok(trackedChildren instanceof Set);
    assert.ok(ALLOWED_PLACEHOLDERS instanceof Set);
  });
});

describe('getEnvCaseInsensitive', () => {
  it('reads exact match first', () => {
    const env = { PATH: '/usr/bin', path: '/bin' };
    assert.equal(getEnvCaseInsensitive(env, 'PATH'), '/usr/bin');
  });

  it('reads case-insensitive match when exact is absent', () => {
    const env = { Path: '/usr/local/bin' };
    assert.equal(getEnvCaseInsensitive(env, 'PATH'), '/usr/local/bin');
  });

  it('returns undefined for non-object or missing key', () => {
    assert.equal(getEnvCaseInsensitive(null, 'PATH'), undefined);
    assert.equal(getEnvCaseInsensitive({}, 'PATH'), undefined);
  });
});

describe('resolveExecutable', () => {
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'proc-test-res-'));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('resolves a temporary executable by absolute path', async () => {
    const filePath = join(tempDir, 'my-tool');
    await writeFile(filePath, '#!/bin/sh\necho hi\n', { mode: 0o755 });

    const result = await resolveExecutable(filePath);
    assert.ok(result, 'should return a non-null path');
    assert.ok(result.includes('my-tool'), 'should include filename');
  });

  it('returns null for a missing binary', async () => {
    const result = await resolveExecutable('totally-nonexistent-binary-xyz', {
      PATH: tempDir,
      PATHEXT: '.EXE',
    });
    assert.equal(result, null);
  });

  it('returns null for a nonexistent explicit path (no throw)', async () => {
    const missingPath =
      process.platform === 'win32'
        ? 'C:\\nope\\does-not-exist-xyz.exe'
        : '/definitely/nonexistent/path/binary-xyz';
    const result = await resolveExecutable(missingPath);
    assert.equal(result, null);
  });

  it('resolves a bare command when PATH is keyed as Path (case-insensitive)', async () => {
    const result = await resolveExecutable('node', {
      Path: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
    });
    assert.ok(result, 'node must resolve even when the env key is Path, not PATH');
  });

  it('returns null for a bare command when env has no path-like key', async () => {
    const result = await resolveExecutable('node', { PATHEXT: process.env.PATHEXT });
    assert.equal(result, null);
  });

  it('on POSIX skips a non-executable PATH entry and resolves a later executable', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX execute-bit semantics only');
      return;
    }
    const earlyDir = await mkdtemp(join(tmpdir(), 'proc-path-early-'));
    const lateDir = await mkdtemp(join(tmpdir(), 'proc-path-late-'));
    try {
      const earlyFile = join(earlyDir, 'mytool');
      await writeFile(earlyFile, '#!/bin/sh\necho early\n', { mode: 0o644 });
      const lateFile = join(lateDir, 'mytool');
      await writeFile(lateFile, '#!/bin/sh\necho late\n', { mode: 0o755 });

      const env = { PATH: `${earlyDir}:${lateDir}` };
      const result = await resolveExecutable('mytool', env);
      assert.equal(result, lateFile);
    } finally {
      await rm(earlyDir, { recursive: true, force: true });
      await rm(lateDir, { recursive: true, force: true });
    }
  });

  it('on POSIX returns null when the only PATH match is non-executable', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX execute-bit semantics only');
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), 'proc-path-noexec-'));
    try {
      const file = join(dir, 'mytool');
      await writeFile(file, '#!/bin/sh\necho hi\n', { mode: 0o644 });
      const result = await resolveExecutable('mytool', { PATH: dir });
      assert.equal(result, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('on Windows resolves .cmd through PATHEXT using temp PATH', async (t) => {
    const cmdPath = join(tempDir, 'foo.cmd');
    await writeFile(cmdPath, '@echo off\r\necho hello\r\n');
    const env = {
      PATH: tempDir,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    };
    const result = await resolveExecutable('foo', env);
    if (process.platform === 'win32') {
      assert.ok(result !== null);
      assert.ok(result.toLowerCase().endsWith('foo.cmd'));
    } else {
      assert.equal(result, null);
    }
  });
});

describe('system32Path', () => {
  it('anchors to a System32 path for requested executable', () => {
    const p = system32Path('cmd.exe');
    const norm = p.replace(/\\/g, '/').toLowerCase();
    assert.ok(norm.includes('/system32/'), `${p} must live under System32`);
    assert.ok(norm.endsWith('/cmd.exe'), `${p} must end with requested exe`);
  });

  it('system32Path is an absolute path on win32', () => {
    const p = system32Path('taskkill.exe');
    if (process.platform === 'win32') {
      assert.ok(p.includes(':') || p.startsWith('\\\\'));
    }
    assert.ok(p.toLowerCase().replace(/\\/g, '/').includes('system32/taskkill.exe'));
  });
});

describe('expandArgs', () => {
  it('contains exactly the 6 allowed placeholders in ALLOWED_PLACEHOLDERS', () => {
    assert.equal(ALLOWED_PLACEHOLDERS.size, 6);
    assert.ok(ALLOWED_PLACEHOLDERS.has('promptFile'));
    assert.ok(ALLOWED_PLACEHOLDERS.has('schemaFile'));
    assert.ok(ALLOWED_PLACEHOLDERS.has('outFile'));
    assert.ok(ALLOWED_PLACEHOLDERS.has('root'));
    assert.ok(ALLOWED_PLACEHOLDERS.has('cwd'));
    assert.ok(ALLOWED_PLACEHOLDERS.has('model'));
  });

  it("expands ['--m', '{model}'] to ['--m', 'a']", () => {
    const result = expandArgs(['--m', '{model}'], { model: 'a' });
    assert.deepEqual(result, ['--m', 'a']);
  });

  it("substitutes all allowed placeholders", () => {
    const template = [
      '{promptFile}',
      '{schemaFile}',
      '{outFile}',
      '{root}',
      '{cwd}',
      '{model}',
    ];
    const values = {
      promptFile: '/p.txt',
      schemaFile: '/s.json',
      outFile: '/out.json',
      root: '/repo',
      cwd: '/workspace',
      model: 'gpt-4o',
    };
    const result = expandArgs(template, values);
    assert.deepEqual(result, [
      '/p.txt',
      '/s.json',
      '/out.json',
      '/repo',
      '/workspace',
      'gpt-4o',
    ]);
  });

  it('rejects unknown placeholder with unknown_placeholder error', () => {
    assert.throws(
      () => expandArgs(['{nope}'], {}),
      /unknown_placeholder/
    );
  });

  it('rejects partial placeholder embedded in arg with unknown_placeholder', () => {
    assert.throws(
      () => expandArgs(['--foo={model}'], { model: 'a' }),
      /unknown_placeholder/
    );
    assert.throws(
      () => expandArgs(['prefix{model}'], { model: 'a' }),
      /unknown_placeholder/
    );
    assert.throws(
      () => expandArgs(['{model}suffix'], { model: 'a' }),
      /unknown_placeholder/
    );
  });

  it('returns empty string for missing placeholder value', () => {
    const result = expandArgs(['--model', '{model}'], {});
    assert.deepEqual(result, ['--model', '']);
  });

  it('returns empty array when template is not array', () => {
    assert.deepEqual(expandArgs(null, {}), []);
  });
});

describe('resolveNpmShim', () => {
  it('resolves fixture .cmd text @"%~dp0\\node_modules\\x\\bin\\x.js" %* to absolute target path', async () => {
    const shimPath = resolve('test/fixtures/proc/shim.cmd');
    const targetPath = resolve('test/fixtures/proc/node_modules/x/bin/x.js');
    const resolved = await resolveNpmShim(shimPath);
    assert.equal(resolved, targetPath);
  });

  it('resolves %dp0% syntax shim', async () => {
    const shimPath = resolve('test/fixtures/proc/dp0-syntax.cmd');
    const targetPath = resolve('test/fixtures/proc/node_modules/x/bin/x.js');
    const resolved = await resolveNpmShim(shimPath);
    assert.equal(resolved, targetPath);
  });

  it('resolves .mjs target shim', async () => {
    const shimPath = resolve('test/fixtures/proc/mjs-shim.cmd');
    const targetPath = resolve('test/fixtures/proc/node_modules/x/bin/target.mjs');
    const resolved = await resolveNpmShim(shimPath);
    assert.equal(resolved, targetPath);
  });

  it('returns null when shim target file is missing', async () => {
    const shimPath = resolve('test/fixtures/proc/missing-target.cmd');
    const resolved = await resolveNpmShim(shimPath);
    assert.equal(resolved, null);
  });

  it('returns null for non-existent file or non-shim file', async () => {
    assert.equal(await resolveNpmShim('test/fixtures/proc/does-not-exist.cmd'), null);
    assert.equal(await resolveNpmShim(null), null);
  });
});

describe('spawnResolved', () => {
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'proc-spawn-'));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('spawns a child as a process-group leader on POSIX', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX process-group leadership only');
      return;
    }
    const child = await spawnResolved(
      process.execPath,
      ['-e', "process.stdout.write('UP'); setTimeout(() => {}, 3000);"],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let up = '';
    child.stdout.on('data', (c) => { up += c.toString(); });
    const exited = new Promise((res) => {
      child.on('close', (code, signal) => res({ code, signal }));
    });
    try {
      const dl = Date.now() + 3000;
      while (!up.includes('UP') && Date.now() < dl) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(up.includes('UP'), 'child must be up');

      let groupExists = false;
      try {
        process.kill(-child.pid, 0);
        groupExists = true;
      } catch {
        groupExists = false;
      }
      assert.ok(groupExists, 'detached child must be process group leader');
    } finally {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
      await exited;
    }
  });

  it('preserves piped stdin/stdout (detached does not change stdio)', async () => {
    const child = await spawnResolved(
      process.execPath,
      ['-e', 'process.stdin.pipe(process.stdout)'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    assert.ok(child.stdin, 'stdin pipe exists');
    assert.ok(child.stdout, 'stdout pipe exists');
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stdin.on('error', () => {});
    child.stdin.end('round6-payload');
    const code = await new Promise((res) => {
      child.on('close', res);
      child.on('error', () => res(null));
    });
    assert.equal(code, 0);
    assert.equal(out, 'round6-payload');
  });

  it('tracks spawned child in trackedChildren', async () => {
    const child = await spawnResolved(process.execPath, ['-e', 'process.exit(0)']);
    assert.ok(trackedChildren.has(child), 'child is in trackedChildren');
    await new Promise((res) => child.on('close', res));
    assert.ok(!trackedChildren.has(child), 'child removed from trackedChildren after close');
  });

  it('on Windows rejects cmd-metacharacter argument for batch wrapper', async (t) => {
    const batPath = join(tempDir, 'test.cmd');
    await writeFile(batPath, '@echo off\r\necho %*\r\n');

    if (process.platform === 'win32') {
      await assert.rejects(
        async () => {
          await spawnResolved(batPath, ['foo&calc']);
        },
        /unsafe_batch_argument/
      );
    } else {
      // Test platform override on POSIX
      await assert.rejects(
        async () => {
          await spawnResolved(batPath, ['foo&calc'], { _platform: 'win32' });
        },
        /unsafe_batch_argument/
      );
    }
  });

  it('on Windows with resolveNpmShim target spawns node directly without metacharacter check', async () => {
    const shimPath = resolve('test/fixtures/proc/shim.cmd');
    // Argument has parentheses, which cmd.exe would normally reject if treated as a raw batch file
    const child = await spawnResolved(
      shimPath,
      ['arg_with_(parentheses)'],
      { _platform: 'win32', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    assert.ok(child && child.pid);
    const code = await new Promise((res) => child.on('close', res));
    assert.equal(code, 0);
  });
});

describe('forceKill', () => {
  it('escalates to SIGKILL for a SIGTERM-trapping child on POSIX', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX-signal behavior only');
      return;
    }
    const child = await spawnResolved(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('READY'); setInterval(() => {}, 1000);"],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    const exited = new Promise((res) => {
      child.on('close', (code, signal) => res({ code, signal }));
    });
    const readyDeadline = Date.now() + 5000;
    while (!out.includes('READY') && Date.now() < readyDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(out.includes('READY'), 'child must signal READY');

    forceKill(child);
    const result = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve('survived'), 6000)),
    ]);
    assert.notEqual(result, 'survived');
    assert.equal(result.signal, 'SIGKILL');
  });

  it('kills a forked descendant (whole process group) on POSIX', async (t) => {
    if (process.platform === 'win32') {
      t.skip('taskkill tree-kills on Windows');
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), 'proc-grp-kill-'));
    const hbFile = join(dir, 'heartbeat.txt');
    const readHb = async () => {
      try { return (await readFile(hbFile, 'utf8')).trim(); } catch { return ''; }
    };
    let parent;
    try {
      const grandchildSrc =
        "const fs=require('fs');" +
        "process.on('SIGTERM',()=>{});" +
        "let n=0;" +
        `setInterval(()=>{n++;try{fs.writeFileSync(${JSON.stringify(hbFile)},String(n));}catch{}},100);`;
      const parentSrc =
        "const {spawn}=require('child_process');" +
        `spawn(process.execPath,['-e',${JSON.stringify(grandchildSrc)}],{stdio:'ignore'});` +
        "process.on('SIGTERM',()=>{});" +
        "setInterval(()=>{},1000);";

      parent = await spawnResolved(process.execPath, ['-e', parentSrc], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const startDeadline = Date.now() + 5000;
      while ((await readHb()) === '' && Date.now() < startDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const beforeKill = await readHb();
      assert.notEqual(beforeKill, '', 'grandchild must start heartbeat');

      forceKill(parent);

      await new Promise((r) => setTimeout(r, 3500));
      const snap1 = await readHb();
      await new Promise((r) => setTimeout(r, 700));
      const snap2 = await readHb();

      assert.equal(snap1, snap2, 'heartbeat must be stopped after forceKill');
    } finally {
      if (parent && parent.pid) {
        try { process.kill(-parent.pid, 'SIGKILL'); } catch {}
        try { process.kill(parent.pid, 'SIGKILL'); } catch {}
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runChild', () => {
  it("runChild with cmd: process.execPath, args: ['-e', 'process.exit(1)'], stdin: 'x'.repeat(1<<20) -> code === 1, no throw", async () => {
    const result = await runChild({
      cmd: process.execPath,
      args: ['-e', 'process.exit(1)'],
      stdin: 'x'.repeat(1 << 20),
    });
    assert.equal(result.code, 1);
    assert.equal(result.timedOut, false);
    assert.equal(result.spawnError, null);
  });

  it('runChild with a child that writes 1 MiB to stderr and exits 0 -> resolves (no deadlock), code 0', async () => {
    const script = `
      process.stderr.write('E'.repeat(1024 * 1024), () => {
        process.exit(0);
      });
    `;
    const result = await runChild({
      cmd: process.execPath,
      args: ['-e', script],
    });
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.stderr.length, 1024 * 1024);
  });

  it('runChild timeout: child traps SIGTERM -> timedOut: true within 4 s (POSIX)', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX-specific SIGTERM trapping test');
      return;
    }
    const script = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)";
    const start = Date.now();
    const result = await runChild({
      cmd: process.execPath,
      args: ['-e', script],
      timeoutMs: 300,
    });
    const elapsed = Date.now() - start;
    assert.equal(result.timedOut, true);
    assert.ok(elapsed < 4000, `timed out and killed within 4s, took ${elapsed}ms`);
  });

  it('A finished runChild leaves no active timer: node -e child with timeoutMs: 600000 exits within 3 s', async () => {
    const testScript = `
      import { runChild } from './skills/adversarial-review/scripts/lib/proc.mjs';
      const start = Date.now();
      await runChild({
        cmd: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 50)'],
        timeoutMs: 600000,
      });
      // Process should now exit naturally because the 600000 timer is cleared
    `;
    const start = Date.now();
    const child = spawn(process.execPath, ['--input-type=module', '-e', testScript], {
      stdio: 'inherit',
    });
    const code = await new Promise((res) => child.on('close', res));
    const elapsed = Date.now() - start;
    assert.equal(code, 0);
    assert.ok(elapsed < 3000, `process should exit well under 3s, took ${elapsed}ms`);
  });

  it('runChild drains stdout and stderr capped at 8 MiB, keeping the tail', async () => {
    // Write 9 MiB of data with marker at the tail using backpressure-aware pump
    const script = `
      const total = 9 * 1024 * 1024;
      let written = 0;
      const chunk = Buffer.alloc(64 * 1024, 0x41); // 'A'
      function pump() {
        while (written < total) {
          written += chunk.length;
          const ok = process.stdout.write(chunk);
          if (!ok) {
            process.stdout.once('drain', pump);
            return;
          }
        }
        process.stdout.write('FINAL_TAIL_MARKER', () => process.exit(0));
      }
      pump();
    `;
    const result = await runChild({
      cmd: process.execPath,
      args: ['-e', script],
    });
    assert.equal(result.code, 0);
    assert.ok(Buffer.byteLength(result.stdout) <= 8 * 1024 * 1024);
    assert.ok(result.stdout.endsWith('FINAL_TAIL_MARKER'), 'tail marker must be preserved');
  });

  it('runChild returns spawnError when executable cannot be resolved', async () => {
    const result = await runChild({
      cmd: 'nonexistent-binary-for-sure-12345',
    });
    assert.equal(result.code, null);
    assert.ok(result.spawnError);
    assert.equal(result.timedOut, false);
  });

  it('runChild invokes onSpawn callback', async () => {
    let capturedChild = null;
    const result = await runChild({
      cmd: process.execPath,
      args: ['-e', 'process.exit(0)'],
      onSpawn: (cp) => {
        capturedChild = cp;
      },
    });
    assert.equal(result.code, 0);
    assert.ok(capturedChild && capturedChild.pid);
  });
});

describe('Tracking and Signal Handlers', () => {
  it('killAllTrackedSync kills all tracked children', async () => {
    const child = await spawnResolved(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' }
    );
    assert.ok(trackedChildren.has(child));
    killAllTrackedSync();
    assert.equal(trackedChildren.size, 0);
    const code = await new Promise((res) => child.on('close', res));
    assert.ok(code !== 0 || child.signalCode != null);
  });

  it('installSignalHandlers cleans up tracked children on SIGINT and exits 130', { skip: process.platform === 'win32' && 'Windows cannot deliver SIGINT through process.kill' }, async () => {
    const script = `
      import { installSignalHandlers, spawnResolved, trackedChildren } from './skills/adversarial-review/scripts/lib/proc.mjs';
      let exitCalled = false;
      installSignalHandlers(async () => {
        exitCalled = true;
      });
      const child = await spawnResolved(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
      process.stdout.write('READY\\n');
      // Wait for signal
    `;
    const proc = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    const deadline = Date.now() + 5000;
    while (!out.includes('READY') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(out.includes('READY'));

    proc.kill('SIGINT');
    const exitCode = await new Promise((res) => proc.on('close', res));
    assert.equal(exitCode, 130);
  });

  it('installSignalHandlers cleans up and exits 1 on uncaughtException', async () => {
    const script = `
      import { installSignalHandlers, spawnResolved } from './skills/adversarial-review/scripts/lib/proc.mjs';
      installSignalHandlers(async (err) => {
        // onExit called
      });
      const child = await spawnResolved(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
      // Trigger uncaught exception
      setTimeout(() => {
        throw new Error('boom');
      }, 50);
    `;
    const proc = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const exitCode = await new Promise((res) => proc.on('close', res));
    assert.equal(exitCode, 1);
  });
});

describe('shared process helpers (v2 ported)', () => {
  it('sanePositiveSec works as expected', () => {
    assert.equal(sanePositiveSec(120, 999), 120);
    assert.equal(sanePositiveSec(0, 77), 77);
    assert.equal(sanePositiveSec(-5, 77), 77);
    assert.equal(sanePositiveSec(Number.NaN, 77), 77);
    assert.equal(sanePositiveSec(Infinity, 77), 77);
    assert.equal(sanePositiveSec('300', 77), 77);
    assert.equal(sanePositiveSec(3_000_000, 120), MAX_SANE_SEC);
  });

  it('runWithTimeout resolves promptly for fast child', async () => {
    const child = spawn(process.execPath, ['-e', "process.stdout.write('x')"], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const start = Date.now();
    const result = await runWithTimeout(child, { timeoutMs: 120000 });
    const elapsed = Date.now() - start;
    assert.notEqual(result, TIMEOUT_SENTINEL);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'x');
    assert.ok(elapsed < 5000);
  });

  it('runWithTimeout returns TIMEOUT_SENTINEL on slow child', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const result = await runWithTimeout(child, { timeoutMs: 200 });
    assert.equal(result, TIMEOUT_SENTINEL);
  });

  it('runWithWatchdog streaming child is not killed by inactivity', async () => {
    const child = spawnNode(
      'let n=0;const t=setInterval(()=>{process.stdout.write(".");if(++n>=5){clearInterval(t);process.exit(0);}},60);'
    );
    const result = await runWithWatchdog(child, { inactivityMs: 200, hardCapMs: 120000 });
    assert.notEqual(result, TIMEOUT_SENTINEL);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.length, 5);
  });

  it('runWithWatchdog kills silent child at inactivity window', async () => {
    const child = spawnNode('setTimeout(() => {}, 10000)');
    const start = Date.now();
    const result = await runWithWatchdog(child, { inactivityMs: 200, hardCapMs: 120000 });
    const elapsed = Date.now() - start;
    assert.equal(result, TIMEOUT_SENTINEL);
    assert.ok(elapsed < 3000);
  });

  it('createMarkerScanner and collectStream detect marker after flood', async () => {
    const MARKER = 'Falling back to default agent';
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    const scanner = createMarkerScanner([MARKER]);

    const captured = collectStream(child, 'stderr', 1024 * 1024, scanner);
    child.stderr.emit('data', Buffer.alloc(1024 * 1024 + 1024, 0x45));
    child.stderr.emit('data', Buffer.from(MARKER + '\n', 'utf8'));
    child.emit('close', 0);

    const stderr = await captured;
    assert.equal(stderr.includes(MARKER), false);
    assert.equal(scanner.hit(), true);
  });
});
