// CLI sift command (§18.1, §8).
import fs from 'node:fs/promises';
import { siftFindings } from '../sift.mjs';
import { loadConfig } from '../config.mjs';
import { writeFileAtomic } from '../fsx.mjs';
import { ConfigError } from '../errors.mjs';

export async function siftCommand(
  flags = {},
  positionals = [],
  { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}
) {
  if (!flags.material || !flags.findings) {
    stderr.write('Error: both --material and --findings are required for sift.\n');
    return 2;
  }

  let materialText;
  try {
    materialText = await fs.readFile(flags.material, 'utf8');
  } catch (err) {
    stderr.write(`Error reading material file "${flags.material}": ${err.message}\n`);
    return 2;
  }

  let findings;
  try {
    const raw = await fs.readFile(flags.findings, 'utf8');
    findings = JSON.parse(raw);
    if (!Array.isArray(findings)) {
      stderr.write(`Error: findings file "${flags.findings}" must contain a JSON array.\n`);
      return 2;
    }
  } catch (err) {
    stderr.write(`Error reading findings file "${flags.findings}": ${err.message}\n`);
    return 2;
  }

  const { config } = loadConfig({ env, flags, stderr });

  const result = await siftFindings({
    material: { text: materialText, kind: 'file' },
    findings,
    config,
    env,
  });

  if (flags.out) {
    try {
      await writeFileAtomic(flags.out, JSON.stringify(result, null, 2) + '\n');
    } catch (err) {
      stderr.write(`Error writing sift output to "${flags.out}": ${err.message}\n`);
      return 2;
    }
  }

  if (flags.json) {
    stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    if (result.status === 'skipped') {
      stdout.write(`sift: skipped (${result.reason || 'unknown'})\n`);
    } else {
      stdout.write(`sift: completed (${result.rows?.length || 0} evaluated rows)\n`);
    }
  }

  return 0;
}
