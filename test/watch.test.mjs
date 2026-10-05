import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, appendFile, utimes } from 'node:fs/promises';
import { watchCommand } from '../skills/adversarial-review/scripts/lib/cli/watch.mjs';
import { makeIsolatedEnv } from './helpers/isolated-env.mjs';
import { runsDir } from '../skills/adversarial-review/scripts/lib/paths.mjs';

async function makeRun(env) {
  const dir = path.join(runsDir(env, process.cwd()), '20261004T000000Z-aaaaaaaa');
  await mkdir(path.join(dir, 'stages'), { recursive: true });
  return dir;
}

function io(env) {
  let out = '';
  return {
    env,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: () => {} },
    pollMs: 20,
    get out() {
      return out;
    },
  };
}

const lock = (pid) => JSON.stringify({ pid, token: 't', createdAt: Date.now() });
// A pid that no process holds on any supported platform.
const DEAD_PID = 2147480000;

test('watch: prints the first wake event at or after --since and the next index', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    const dir = await makeRun(env);
    await writeFile(path.join(dir, 'lock'), lock(process.pid));
    await writeFile(
      path.join(dir, 'events.jsonl'),
      '{"event":"call_start","seat":"edge"}\n{"event":"seat_done","seat":"edge","stage":"FIND","findings":[{"id":"edge-1","severity":"minor","title":"x\\u001b[31m","file":null,"fileRaw":"/etc/p","line":1}]}\n'
    );
    const o = io(env);
    const code = await watchCommand({ since: '0' }, [dir], o);
    assert.equal(code, 0);
    assert.match(o.out, /\[1\] seat_done edge/);
    assert.match(o.out, /edge-1 minor x\[31m @ \/etc\/p:1/);
    assert.ok(!o.out.includes('\u001b'));
    assert.match(o.out.trim().split('\n').at(-1), /^next: 2$/);
  } finally {
    await cleanup();
  }
});

test('watch: a partial last line is not an event until its newline arrives', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    const dir = await makeRun(env);
    await writeFile(path.join(dir, 'lock'), lock(process.pid));
    await writeFile(path.join(dir, 'events.jsonl'), '{"event":"stage_end","stage":"find"');
    const o = io(env);
    const p = watchCommand({ since: '0', json: true }, [dir], o);
    setTimeout(() => appendFile(path.join(dir, 'events.jsonl'), '}\n'), 80);
    assert.equal(await p, 0);
    const r = JSON.parse(o.out);
    assert.equal(r.index, 0);
    assert.equal(r.next, 1);
    assert.equal(r.owner, 'alive');
  } finally {
    await cleanup();
  }
});

test('watch: finished run with no wake event prints a synthetic run_end from result.json', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    const dir = await makeRun(env);
    await writeFile(path.join(dir, 'events.jsonl'), '{"event":"call_start"}\n');
    await writeFile(path.join(dir, 'result.json'), JSON.stringify({ gateVerdict: 'PASS', exitCode: 0 }));
    const o = io(env);
    assert.equal(await watchCommand({ since: '1', json: true }, [dir], o), 0);
    const r = JSON.parse(o.out);
    assert.equal(r.event.event, 'run_end');
    assert.equal(r.event.synthetic, true);
    assert.equal(r.event.gateVerdict, 'PASS');
    assert.equal(r.finished, true);
    assert.equal(r.next, 1);
  } finally {
    await cleanup();
  }
});

test('watch: dead owner exits 3, hung owner exits 5', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    const dir = await makeRun(env);
    await writeFile(path.join(dir, 'lock'), lock(DEAD_PID));
    const dead = io(env);
    assert.equal(await watchCommand({ since: '0' }, [dir], dead), 3);
    assert.match(dead.out, /owner dead/);
    assert.match(dead.out, /run --resume ".*" --detach/);
    await writeFile(path.join(dir, 'lock'), lock(process.pid));
    const old = new Date(Date.now() - 700000);
    await utimes(path.join(dir, 'lock'), old, old);
    const hung = io(env);
    assert.equal(await watchCommand({ since: '0' }, [dir], hung), 5);
    assert.match(hung.out, new RegExp(`owner hung.*${process.pid}`));
  } finally {
    await cleanup();
  }
});

test('watch: --timeout exits 4, bad --since or --timeout exits 2', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    const dir = await makeRun(env);
    await writeFile(path.join(dir, 'lock'), lock(process.pid));
    const o = io(env);
    assert.equal(await watchCommand({ since: '0', timeout: '1' }, [dir], o), 4);
    assert.match(o.out.trim().split('\n').at(-1), /^next: 0$/);
    assert.equal(await watchCommand({ since: '-1' }, [dir], io(env)), 2);
    assert.equal(await watchCommand({ since: '1.5' }, [dir], io(env)), 2);
    assert.equal(await watchCommand({ since: '0', timeout: '0' }, [dir], io(env)), 2);
    assert.equal(await watchCommand({ since: '0' }, [], io(env)), 2);
  } finally {
    await cleanup();
  }
});

test('watch: a final run_end wins over a released lock', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    const dir = await makeRun(env);
    await writeFile(path.join(dir, 'events.jsonl'), '{"event":"run_end","stopped":"until-find"}\n');
    const o = io(env);
    assert.equal(await watchCommand({ since: '5', json: true }, [dir], o), 0);
    const r = JSON.parse(o.out);
    assert.equal(r.index, 0);
    assert.equal(r.event.stopped, 'until-find');
    assert.equal(r.finished, true);
  } finally {
    await cleanup();
  }
});

test('watch: the exit cleanup record after run_end does not hide the run end', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    const dir = await makeRun(env);
    await writeFile(
      path.join(dir, 'events.jsonl'),
      '{"event":"run_end","stopped":"until-find"}\n{"event":"cleanup","killed":0,"stillAlive":[]}\n'
    );
    assert.equal(await watchCommand({ since: '2' }, [dir], io(env)), 0);
  } finally {
    await cleanup();
  }
});

test('watch: a run_end followed by later events is not final', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    const dir = await makeRun(env);
    await writeFile(path.join(dir, 'events.jsonl'), '{"event":"run_end"}\n{"event":"call_start"}\n');
    assert.equal(await watchCommand({ since: '2' }, [dir], io(env)), 3);
  } finally {
    await cleanup();
  }
});

test('watch: a run directory outside the state directory exits 2', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    assert.equal(await watchCommand({ since: '0' }, [process.cwd()], io(env)), 2);
  } finally {
    await cleanup();
  }
});
