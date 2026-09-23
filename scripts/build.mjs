import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSeats, defaultSeatsDir, renderSeat } from '../skills/adversarial-review/scripts/lib/seats.mjs';

export function defaultAgentsDir() {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  return path.join(repoRoot, 'agents');
}

export function build({
  check = false,
  seatsDir = defaultSeatsDir(),
  agentsDir = defaultAgentsDir(),
} = {}) {
  const seats = loadSeats(seatsDir);
  const changed = [];

  if (check) {
    if (!fs.existsSync(agentsDir)) {
      for (const seat of seats.values()) {
        changed.push(`rt-${seat.key}.md`);
      }
      return { changed };
    }

    for (const seat of seats.values()) {
      const fileName = `rt-${seat.key}.md`;
      const agentPath = path.join(agentsDir, fileName);
      if (!fs.existsSync(agentPath)) {
        changed.push(fileName);
        continue;
      }
      const existing = fs.readFileSync(agentPath, 'utf8');
      const expected = renderSeat(seat, 'claude-agent');
      if (existing !== expected) {
        changed.push(fileName);
      }
    }

    return { changed };
  }

  // Not check: render and write all agent files
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const seat of seats.values()) {
    const fileName = `rt-${seat.key}.md`;
    const agentPath = path.join(agentsDir, fileName);
    const rendered = renderSeat(seat, 'claude-agent');
    fs.writeFileSync(agentPath, rendered, 'utf8');
    changed.push(fileName);
  }

  return { changed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const check = process.argv.includes('--check');
  const res = build({ check });
  if (check) {
    if (res.changed.length > 0) {
      for (const file of res.changed) {
        console.error(`Difference found in agent file: ${file}`);
      }
      process.exit(1);
    }
    process.exit(0);
  } else {
    console.log(`Generated ${res.changed.length} agent files in agents/`);
    process.exit(0);
  }
}
