// Echo seat fixture: reads stdin and prints a fenced JSON block matching FINDINGS schema.
import { readFileSync } from 'node:fs';

const _stdin = readFileSync(0, 'utf8');
console.log('```json\n{"findings":[]}\n```');
