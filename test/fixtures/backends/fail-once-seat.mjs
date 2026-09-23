// Fail once fixture: exits 1 on first attempt, then succeeds on second attempt.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const stateFile = process.env.STATE_FILE || 'fail-once-state.txt';
const _stdin = readFileSync(0, 'utf8');

if (!existsSync(stateFile)) {
  writeFileSync(stateFile, 'failed-once', 'utf8');
  process.exit(1);
}

console.log('```json\n{"findings":[]}\n```');
