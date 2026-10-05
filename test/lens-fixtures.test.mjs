import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LENSES } from '../skills/adversarial-review/scripts/lib/catalog.mjs';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/adversarial-review/bench/lenses');

test('every lens has a fixture with 3 to 6 keyed defects whose lines exist', async () => {
  assert.deepEqual(LENSES, ['breaker', 'edge', 'attacker', 'racer', 'keeper', 'medic', 'tester', 'historian', 'simplifier']);
  for (const lens of LENSES) {
    const files = await readdir(path.join(dir, lens));
    const key = JSON.parse(await readFile(path.join(dir, lens, 'answer-key.json'), 'utf8'));
    assert.ok(key.length >= 3 && key.length <= 6, lens);
    const material = files.find((f) => f.startsWith('material'));
    const lines = (await readFile(path.join(dir, lens, material), 'utf8')).split('\n').length;
    for (const d of key) {
      assert.ok(d.id && Array.isArray(d.keywords) && d.keywords.length > 0, `${lens}:${d.id}`);
      assert.ok(Math.max(...d.lines) <= lines, `${lens}:${d.id} line out of range`);
    }
  }
});

// A 3-defect fixture can never reach `standard` (scoreBench needs score >= 4), so research would
// never take that seat. Every lens carries 5 or 6 defects for that reason.
test('every lens fixture can reach the standard tier and each material file covers the key', async () => {
  for (const lens of LENSES) {
    const files = await readdir(path.join(dir, lens));
    const key = JSON.parse(await readFile(path.join(dir, lens, 'answer-key.json'), 'utf8'));
    assert.ok(key.length >= 5, `${lens}: ${key.length} defects cannot reach the standard tier`);
    const ids = new Set(key.map((d) => d.id));
    assert.equal(ids.size, key.length, `${lens}: duplicate defect id`);
    const maxLine = Math.max(...key.flatMap((d) => d.lines));
    for (const file of files.filter((f) => f.startsWith('material'))) {
      const lines = (await readFile(path.join(dir, lens, file), 'utf8')).split('\n').length;
      assert.ok(lines >= maxLine, `${lens}/${file}: ${lines} lines, key needs ${maxLine}`);
      assert.ok(lines >= 25, `${lens}/${file}: ${lines} lines is under the 25-line floor`);
    }
  }
});
