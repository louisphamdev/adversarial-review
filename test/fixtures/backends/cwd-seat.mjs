// CWD test fixture: records process.cwd() to a file and prints it in JSON.
import { readFileSync, writeFileSync } from 'node:fs';

const _stdin = readFileSync(0, 'utf8');
const curCwd = process.cwd();
if (process.env.CWD_RECORD_FILE) {
  writeFileSync(process.env.CWD_RECORD_FILE, curCwd, 'utf8');
}

console.log(`\`\`\`json\n{"ok":true,"cwd":${JSON.stringify(curCwd)}}\n\`\`\``);
