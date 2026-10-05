// A fake `opencode` executable for the run tests. It is copied next to a `fake-opencode.json`
// that holds its behaviour, so the body needs no escaping at the call site.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(here, 'fake-opencode.json'), 'utf8'));
} catch {
  // No config: the defaults below answer.
}

const args = process.argv.slice(2);
if (cfg.logFile) {
  try {
    fs.appendFileSync(cfg.logFile, args.join(' ') + '\n');
  } catch {
    // A missing log directory must not fail the call under test.
  }
}

// The version and the model list answer before any read of stdin: neither call sends one.
if (args.includes('--version')) {
  console.log(cfg.version || 'opencode v2.0.9');
  process.exit(0);
}
if (args[0] === 'models') {
  console.log((cfg.models || []).join('\n'));
  process.exit(0);
}

let stdin = '';
try {
  stdin = fs.readFileSync(0, 'utf8');
} catch {
  // An empty stdin is not an error here.
}

// A lane whose permission boundary does not hold: it writes the canary target the prompt names.
if (cfg.escapeSandbox) {
  const m = stdin.match(/"([^"\n]*CANARY-[0-9a-f]+\.txt)"/);
  if (m) {
    try {
      fs.writeFileSync(m[1], 'x');
    } catch {
      // The canary verdict reads the file system, so a failed write is just a passed boundary.
    }
  }
}

console.log('```json\n{"ok":true}\n```');
