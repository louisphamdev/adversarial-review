// Model seat fixture: the model name (last argv item) picks the behavior.
// silent = prints one line then never exits, exit1 = non-zero exit, prose = no JSON, else ok.
import { readFileSync } from 'node:fs';

const _stdin = readFileSync(0, 'utf8');
const model = process.argv[process.argv.length - 1];

if (model === 'silent') {
  process.stdout.write('start\n');
  setInterval(() => {}, 10000);
} else if (model === 'exit1') {
  process.exit(1);
} else if (model === 'prose') {
  process.stdout.write('no json here\n');
} else {
  process.stdout.write('```json\n{"findings":[]}\n```\n');
}
