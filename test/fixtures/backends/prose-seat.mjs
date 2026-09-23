// Prose seat fixture: prints non-JSON prose to trigger parse error.
import { readFileSync } from 'node:fs';

const _stdin = readFileSync(0, 'utf8');
console.log('I am just explaining things in plain English without any JSON output at all.');
