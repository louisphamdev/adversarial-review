// Sleep seat fixture: hangs so that the call exceeds timeoutMs.
import { readFileSync } from 'node:fs';

const _stdin = readFileSync(0, 'utf8');
setTimeout(() => {
  console.log('```json\n{"findings":[]}\n```');
}, 10000);
