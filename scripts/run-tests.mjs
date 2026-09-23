// Lists test/**/*.test.mjs itself: `node --test <dir>` behaves differently on Node 20 and 22,
// and a bare `node --test` also runs work files under temp/.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function collect(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'fixtures' || e.name === 'helpers' ? [] : collect(p);
    return e.name.endsWith('.test.mjs') ? [p] : [];
  });
}

const only = process.argv.slice(2);
const files = only.length ? only : collect('test').sort();
if (files.length === 0) {
  console.log('no test files');
  process.exit(0);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
