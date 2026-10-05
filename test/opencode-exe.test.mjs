import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveOpencodeExe } from '../skills/adversarial-review/scripts/lib/backends/opencode.mjs';

test('config exe wins', async () => {
  const r = await resolveOpencodeExe({ backends: { opencode: { exe: 'X:/oc/opencode.exe' } } }, {}, { platform: 'win32', exists: async () => true });
  assert.equal(r.exe, 'X:/oc/opencode.exe');
});

test('on win32 an .exe anywhere on absolute PATH entries beats an earlier .cmd wrapper', async () => {
  const env = { PATH: ['C:\\bin', 'rel\\dir', 'C:\\tools'].join(';'), USERPROFILE: 'C:\\Users\\u' };
  const present = new Set([path.win32.join('C:\\bin', 'opencode.cmd'), path.win32.join('C:\\tools', 'opencode.exe')]);
  const r = await resolveOpencodeExe({}, env, { platform: 'win32', exists: async (p) => present.has(p) });
  assert.equal(r.exe, path.win32.join('C:\\tools', 'opencode.exe'));
  assert.ok(!r.searched.some((p) => p.startsWith('rel')), 'relative PATH entries are not searched');
});

test('on win32 the fixed user path is the fallback, and null lists every searched location', async () => {
  const env = { PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\u' };
  const fixed = path.win32.join('C:\\Users\\u', '.opencode', 'bin', 'opencode.exe');
  const hit = await resolveOpencodeExe({}, env, { platform: 'win32', exists: async (p) => p === fixed });
  assert.equal(hit.exe, fixed);
  const miss = await resolveOpencodeExe({}, env, { platform: 'win32', exists: async () => false });
  assert.equal(miss.exe, null);
  assert.ok(miss.searched.includes(fixed));
});

test('with no .exe anywhere the PATHEXT lookup is the last resort and is reported as searched', async () => {
  const env = { PATH: '' };
  const r = await resolveOpencodeExe({}, env, { platform: 'win32', exists: async () => false });
  assert.equal(r.exe, null);
  assert.ok(r.searched.includes('PATH:opencode'), 'the last-resort lookup is reported as searched');
});

test('the last-resort lookup honors the injected exists seam, not the real filesystem', async () => {
  const env = { PATH: 'C:\\bin', PATHEXT: '.com;.exe;.bat;.cmd' };
  const wrapper = path.win32.join('C:\\bin', 'opencode.cmd');
  const r = await resolveOpencodeExe({}, env, {
    platform: 'win32',
    exists: async (candidate) => candidate === wrapper,
  });
  assert.equal(r.exe, wrapper, 'the wrapper the seam reports as present is the last resort');
});

test('on POSIX PATH wins, and the installer path under HOME is the fallback', async () => {
  const fixed = path.posix.join('/home/u', '.opencode', 'bin', 'opencode');
  const onPath = path.posix.join('/usr/bin', 'opencode');
  const env = { PATH: '/usr/bin', HOME: '/home/u' };
  const both = await resolveOpencodeExe({}, env, { platform: 'linux', exists: async (p) => p === onPath || p === fixed });
  assert.equal(both.exe, onPath);
  const hit = await resolveOpencodeExe({}, env, { platform: 'darwin', exists: async (p) => p === fixed });
  assert.equal(hit.exe, fixed);
  const miss = await resolveOpencodeExe({}, env, { platform: 'linux', exists: async () => false });
  assert.equal(miss.exe, null);
  assert.ok(miss.searched.includes(fixed), 'the fallback is reported as searched');
});
