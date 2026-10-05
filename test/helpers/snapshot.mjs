import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const DIR = path.resolve(import.meta.dirname, '..', 'fixtures', 'prompts');

// Compares text with a stored snapshot; UPDATE_SNAPSHOTS=1 rewrites it.
export function expectSnapshot(name, text) {
  const file = path.join(DIR, `${name}.txt`);
  const norm = text.replace(/\r\n/g, '\n');
  if (process.env.UPDATE_SNAPSHOTS === '1') {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, norm, 'utf8');
    return;
  }
  assert.ok(fs.existsSync(file), `missing snapshot ${name}; run with UPDATE_SNAPSHOTS=1 and review the file`);
  assert.equal(norm, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), `snapshot ${name} differs`);
}
